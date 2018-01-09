const slack = require('@slack/client');
const fs = require('fs');

const RtmClient = slack.RtmClient;
const CLIENT_EVENTS = slack.CLIENT_EVENTS;
const RTM_EVENTS = slack.RTM_EVENTS;
const MemoryDataStore = slack.MemoryDataStore;
const token = process.env.SLACK_API_TOKEN;

const rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore(), // pass a new MemoryDataStore instance to cache information
});

rtm.start();

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, () => {
  console.log('RTM client authenticated!', new Date());
});

const channelsMap = {};

//-----------------------------------------------------------
function getSlackUser(user) {
  const userobj = rtm.dataStore.getUserById(user);
  if (!userobj) {
    return null;
  }
  return userobj.name;
}
//-----------------------------------------------------------
function getSlackChannel(channelId) {
  const chanobj = rtm.dataStore.getChannelById(channelId);
  if (!chanobj) {
    return null;
  }
  return chanobj.name;
}

rtm.on(RTM_EVENTS.MESSAGE, (message) => {
  try {
    if (!message.user || !message.text) {
      return;
    }

    const slackuser = getSlackUser(message.user);
    if (!slackuser) {
      console.log('error getting slackuser', message);
      return;
    }
    const channel = getSlackChannel(message.channel);
    if (!channel) {
      console.log('error getting channel', message);
      return;
    }

    if (!channelsMap[channel]) {
      channelsMap[channel] = {};
    }

    if (!channelsMap[channel][slackuser]) {
      channelsMap[channel][slackuser] = {
        messages: 0,
        letters: 0,
      };
    }

    if (message.text) {
      channelsMap[channel][slackuser].messages++;
      channelsMap[channel][slackuser].letters += message.text.length;
    }

    fs.writeFileSync('chanstat.json', JSON.stringify(channelsMap));
    console.log(channel, slackuser, message.text);
  } catch (err) {
    console.error(err, err.stack);
  }
});

