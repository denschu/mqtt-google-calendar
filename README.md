# mqtt-google-calendar

This application is a Google Calendar bridge that can publish to user defined topics to a MQTT broker at the start and end of an Google Calendar event. 

## Setup

	sudo npm install mqtt-google-calendar -g
	
## Start broker

Start the MQTT broker with

	mosquitto
	
## Configuration

Create/Modify configuration "config.json"


	{
		"calendar_id":"foo@group.calendar.google.com",
		"client_secret":"foobar",
	   	"client_id":"foobar.apps.googleusercontent.com",
	   	"refresh_token":"foo"              
	}

## Start application

Start application with the path to the config file and the URL of the MQTT broker

	mqtt-google-calendar -c /path/to/config.json -h mqtt://localhost:1883

or add this lines to "/etc/rc.local" to run the application on startup (Raspberry Pi)

	export PATH="$PATH:/opt/node/bin"
	mqtt-google-calendar -c /path/to/config.json > mqtt-google-calendar.log -h mqtt://localhost:1883  &

You can also set the MQTT broker url as environment variable

	export MQTT_BROKER_URL=mqtt://localhost:1883

To grant the application access to the Google Calendar, open the adress displayed by the application with a browser of your choice while logged in to a Google account and enter the displayed code. The application will periodically check if you already entered the code after which it will begin to check the calendar automatically.  

When running topic:payload tuples can be scheduled to be published at the start and end of an calendar event. 
A description of the following format can be added to events in the specified calendar. 

	"start":{"/topic":"payload", "/foo/bar":1},"end":{"/foo/bar/":0}




