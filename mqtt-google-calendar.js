#!/usr/bin/env node
var express = require('express');
var oauth = require('oauth');
var os = require("os");
var https= require('https');
var querystring = require('querystring');
var log4js = require('log4js')
var logger = log4js.getLogger();
var optimist = require('optimist');
var mqtt = require('mqtt');
var url = require('url');
var fs = require('fs');
var schedule = require('node-schedule');

var accessToken, accessTokenRefreshIn, oa, deviceCode;
var settings = {};
var scheduled = false;
var calendarQueryInterval = 30*60*1000;

var argv = optimist
  .usage('mqtt-exec: receive shell commands on MQTT messages\n \
    Usage: mqtt-exec -h <broker-url>')
  .options('h', {
      describe: 'broker url'
    , default: 'mqtt://localhost:1883'
    , alias: 'broker-url'
  })
  .options('c', {
      describe: 'configFile'
    , default: __dirname + '/config.json'
    , alias: 'configFile'
  })
  .argv;

// Parse url
var mqtt_url = url.parse(process.env.MQTT_BROKER_URL || argv.h);
var auth = (mqtt_url.auth || ':').split(':');

var configuration = {};
var scheduledPublishes = [];

//Loading config
if (argv.c || argv.configFile) {
    var configFile = argv.c || argv.configFile;
    logger.info("Reading configuration from %s", configFile);
    configuration = JSON.parse(fs.readFileSync(configFile).toString());
}

var clientId = configuration.client_id;
var clientSecret = configuration.client_secret;
var calendarId = configuration.calendar_id;
var refreshToken = configuration.refresh_token;;

//Creating the MQTT Client
logger.info("Creating client for: " + mqtt_url.hostname);
var c = mqtt.createClient(mqtt_url.port, mqtt_url.hostname, {
  username: auth[0],
  password: auth[1]
});

c.on('connect', function() {
  logger.info("CALENDAR", "Bootstrapping....");
  oauth2bootstrap();
});

// Checks if there is a saved OAuth refresh token or if the application has to be authorized to access the user's calendar
function oauth2bootstrap() {
	oa = new oauth.OAuth2(clientId, clientSecret, "https://accounts.google.com/o", "/oauth2/auth", "/oauth2/token");
	if(refreshToken == undefined || refreshToken == "" )
		oauth2authorize(); // No refresh token. Request autorization
	else
		oauth2refreshAccessToken(); // Refresh token present, Request a OAuth2 access token and start querying the calendar
}

// Requests authorization (using https://developers.google.com/accounts/docs/OAuth2ForDevices) to access the user's calendar. 
function oauth2authorize(){
	logger.info("OAUTH2", "No refresh token provided. Requesting authorization from user.");
	// Create inital request to obtain a "user code"
	var initialRequestData = querystring.stringify({'client_id' : clientId, 'scope' : 'https://www.googleapis.com/auth/calendar'}); 
	var initialRequestOptions = {host: 'accounts.google.com', port : 443, path: '/o/oauth2/device/code', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': initialRequestData.length}};
	var initialRequest = https.request(initialRequestOptions, function(response) {
	  response.setEncoding('utf8');
	  response.on('data', function (chunk) {
	    	var initialResponse = JSON.parse(chunk);
	    	// Query function that periodically checks if the user has entered the code and granted access already
	  		var query = function() {
					var secondaryRequestData = querystring.stringify({'client_id' : clientId, 'client_secret' : clientSecret, 'code' : initialResponse.device_code, 'grant_type' : 'http://oauth.net/grant_type/device/1.0'}); 
					var secondaryRequestOptions = {host: 'accounts.google.com', port : 443, path: '/o/oauth2/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': secondaryRequestData.length}};						
					var secondaryRequest = https.request(secondaryRequestOptions, function(response) {
	  				response.setEncoding('utf8');
	  				response.on('data', function (chunk) {
	  						var secondaryResponse = JSON.parse(chunk);
	  						if(secondaryResponse.error) {	// User has not yet entered the code and granted access
	  							setTimeout(query, initialResponse.interval*1000+5000);
									logger.info("OAUTH2", "Authorization pending. Please go to %s and enter the code: %s", initialResponse.verification_url, initialResponse.user_code);
	  						} else {	// User has entered the code to authorize this application. The response includes an initial OAuth access and refresh token.
									oauth2parseAccessToken(secondaryResponse);
	  						}
						});
	  			});
					secondaryRequest.on('error', function(e) {logger.error('Secondary request returned: %s', e.message);});
					secondaryRequest.write(secondaryRequestData);  
					secondaryRequest.end();  
	  		}
	  		// Send query
	  		query();
	  });
	});

	initialRequest.on('error', function(e) {logger.error('Initial request returned: %s', e.message);});
	initialRequest.write(initialRequestData);  
	initialRequest.end();  
}

// Parses a API response that contains an access token (and possible a refresh token)
// Schedules the refresh of the access token before it expires
// Also initiates the scheduling of regular calendar queries 
function oauth2parseAccessToken(results) {
  accessToken = results.access_token;
  accessTokenRefreshIn = !!results.expires_in ? (results.expires_in-600)*1000: accessTokenRefreshIn;
  
  if(results.refresh_token && (refreshToken != results.refresh_token)){
  	refreshToken = results.refresh_token;
  }
  	
  logger.info("OAUTH", "Access token: " + accessToken);
  logger.info("OAUTH", "Access token refresh in: " + accessTokenRefreshIn+"ms");
  logger.info("OAUTH", "Refresh token: " + refreshToken);
  logger.info("OAUTH", "Token type: " + results.token_type);
  setTimeout(oauth2refreshAccessToken, accessTokenRefreshIn);
  if(!scheduled){
  	process.nextTick(calendarScheduleQuery);
  }
 		
}
function schedulePublish(date, topic, payload, retained){
	logger.info("SCHEDULE", "At "+ date +", publishing "+topic+":"+payload+" (retained="+retained+")");
	var job = schedule.scheduleJob(date, function(){
		logger.info("PUBLISH", "Publishing "+topic+":"+payload+" (retained="+retained+")");
		c.publish(topic, payload, {retain: true});
	});
	scheduledPublishes.push(job);
}

// Refreshes the OAuth access token with an existing refresh token
function oauth2refreshAccessToken() {
	logger.info("OAUTH", "Refreshing access token");
  	oa.getOAuthAccessToken(refreshToken, {grant_type:'refresh_token'}, function(err, access_token, refresh_token, results) {
		if (err)
		  logger.error("OAUTH", "Error: " + JSON.stringify(err));
		else
			oauth2parseAccessToken(results);
	});
}

// Schedules regular calendar queries 
function calendarScheduleQuery(){
	setTimeout(calendarQuery, calendarQueryInterval);
	process.nextTick(calendarQuery);
}

// Queries the calendar API and schedules publishes depending on the returned events that start during the specified query intervall
function calendarQuery() {
	// Note, according to the Google Calendar Api definition timeMin and timeMax are not necessarily what one might expect: 
	// timeMin == Lower bound (inclusive) for an event's end time to filter by. Optional. The default is not to filter by end time. (string)
	// timeMax == Upper bound (exclusive) for an event's start time to filter by. Optional. The default is not to filter by start time. (string)
	var timeMax = encodeURIComponent(new Date((new Date()).getTime()+ (calendarQueryInterval + (5*60*1000))).toISOString());
	var timeMin = new Date();
	var query = "https://www.googleapis.com/calendar/v3/calendars/"+calendarId+"/events?singleEvents=true&fields=items(id%2Cdescription%2Cstart%2Cend%2Csummary)&orderBy=startTime&timeMin="+encodeURIComponent(timeMin.toISOString())+"&timeMax="+timeMax;	
	logger.info("CALENDAR", "Executing query: " + query); 
	oa.get( query, accessToken, function (error, result, response) {
		if(error) {
			logger.error("CALENDAR", "Error: %s", error); 
		} else {
			try {
				var items = JSON.parse(result).items
				if (items == undefined) {
					return;
				}

			} catch (e) {
				logger.error("CALENDAR", "%s", e); 
				return;
			}

			// Schedule events
			for(i=0;i<items.length;i++){
  			var item = items[i];
  			try {
					item.description = (item.description.substring(0,1) != '{' ? '{' : '') + item.description + (item.description.substring(item.description.length-1,item.description) != '}' ? '}' : '');
					try { // Try to parse event payload. Continue with next item if description is broken
						var payload = JSON.parse(item.description);
					} catch (e) {
						logger.error("CALENDAR", "Unable to parse event description: %s", item.description);
						logger.error("CALENDAR", e);
						continue;
					}

					// Check if the event started in the past (and thus has been scheduled already)
					if (new Date(item.start.dateTime) < timeMin) {
						logger.info("CALENDAR", "Ignoring Event From past (start@ " + item.start.dateTime + ")"); 
						continue;
					}

					// Schedule start events
					for(key in payload.start){
						schedulePublish(new Date(item.start.dateTime), key, payload.start[key], true); 
					}

					// Schedule end events
					for(key in payload.end){
						schedulePublish(new Date(item.end.dateTime), key, payload.end[key], true); 
					}
				} catch (e) {
					logger.error("CALENDAR", "%s", e); 
					continue;
				}
    	}
		}
	});	
}