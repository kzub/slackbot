var slack = require('@slack/client');
var fs = require('fs');
var request = require('request');

var RtmClient = slack.RtmClient;
var CLIENT_EVENTS = slack.CLIENT_EVENTS;
var RTM_EVENTS = slack.RTM_EVENTS;
var MemoryDataStore = slack.MemoryDataStore;
var token = process.env.SLACK_API_TOKEN;
var token2 = process.env.SLACK_API_TOKEN_LEGACY;

var rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore() // pass a new MemoryDataStore instance to cache information
});

rtm.start();

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function handleRTMAuthenticated() {
  console.log('RTM client authenticated!', new Date());
});

var channelsMap = {};
var validUsers = process.env.VALID_USERS.split(' ');

rtm.on(RTM_EVENTS.MESSAGE, function handleRtmMessage(message) {
  try {
    if (!message.user || !message.text) {
      return;
    }

    var slackuser = getSlackUser(message.user);
    if (!slackuser) {
      console.log("error getting slackuser", message);
      return;
    }
    var channel = getSlackChannel(message.channel);
    if (!channel) {
      console.log("error getting channel", message);
      return;
    }
    console.log(channel, slackuser, message.text);
    if (channel != 'pulse'){
       return;
    }
    if (validUsers.indexOf(slackuser) > -1) {
       return;
    }

    console.log('DELETE MESSAGE ^^^');
    var url =  'https://slack.com/api/chat.delete?token=' + token2;
    url += "&ts=" + message.ts;
    url += "&channel=" + message.channel;
    url += "&as_user=true&pretty=1";

    request(url, function(err, data) {
       if(err){
          console.log(err);
       }
    });
  } catch(err) {
    console.error(err, err.stack);
  }
});

//-----------------------------------------------------------
function getSlackUser(user) {
  var userobj = rtm.dataStore.getUserById(user);
  if (!userobj) {
    return;
  }
  return userobj.name;
}
//-----------------------------------------------------------
function getSlackChannel(channelId) {
  var chanobj = rtm.dataStore.getChannelById(channelId);
  if (!chanobj) {
    return;
  }
  return chanobj.name;
}



