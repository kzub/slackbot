var slack = require('@slack/client');
var fs = require('fs');

var RtmClient = slack.RtmClient;
var CLIENT_EVENTS = slack.CLIENT_EVENTS;
var RTM_EVENTS = slack.RTM_EVENTS;
var MemoryDataStore = slack.MemoryDataStore;
var token = process.env.SLACK_API_TOKEN;

var rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore() // pass a new MemoryDataStore instance to cache information
});

rtm.start();

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function handleRTMAuthenticated() {
  console.log('RTM client authenticated!');
});

var channelsMap = {};

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

    if (!channelsMap[channel]) {
      channelsMap[channel] = {};
    }

    if (!channelsMap[channel][slackuser]) {
      channelsMap[channel][slackuser] = {
        messages: 0,
        letters: 0
      };
    }

    if (message.text) {
      channelsMap[channel][slackuser].messages++;
      channelsMap[channel][slackuser].letters += message.text.length;      
    }
  
    fs.writeFileSync('chanstat.json', JSON.stringify(channelsMap));
    console.log(channel, slackuser, message.text);
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



