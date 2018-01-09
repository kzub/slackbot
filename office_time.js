const slack = require('@slack/client');
const fs = require('fs');
const request = require('request');
const { spawn } = require('child_process');

const RtmClient = slack.RtmClient;
const CLIENT_EVENTS = slack.CLIENT_EVENTS;
const RTM_EVENTS = slack.RTM_EVENTS;
const MemoryDataStore = slack.MemoryDataStore;
const token = process.env.SLACK_API_TOKEN;
const token2 = process.env.SLACK_API_TOKEN_LEGACY;
const configName = 'office_time.conf';

const rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore(), // pass a new MemoryDataStore instance to cache information
});

rtm.start();

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, () => {
  console.log('RTM client authenticated!', new Date());
});

const channelsMap = {};
const config = JSON.parse(fs.readFileSync(configName));

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
    if (channel) {
      // not direct message
      return;
    }

    if (config.admins[slackuser] && processAdminMessage(message.text, message.channel)) {
      return;
    }
    if (config.users[slackuser]) {
      console.log(`${new Date().toJSON()} ${slackuser} check user:${message.text}`);
      processUserMessage(message.text, message.channel);
      return;
    }

    rtm.sendMessage('¯\\_(ツ)_/¯', message.channel);

  } catch (err) {
    console.error(err, err.stack);
  }
});


function processUserMessage(message, msgChannelId) {
  checkUserAtSkud(message, (result) => {
    rtm.sendMessage(result, msgChannelId);
  });
}

function processAdminMessage(message, msgChannelId) {
  const parts = message.split(' ');
  const cmd = parts[0];
  const name = parts[1];

  if (cmd === 'add') {
    const user = rtm.dataStore.getUserByName(name);
    if (!user) {
      rtm.sendMessage(`failed. unknown user ${name}`, msgChannelId);
      return true;
    }

    config.users[name] = true;
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage('ok', msgChannelId);
    return true;
  }

  if (cmd === 'list') {
    const msg = [];
    for (const user in config.users) {
      msg.push(user);
    }
    rtm.sendMessage(msg.join('\n'), msgChannelId);
    return true;
  }

  if (cmd === 'del') {
    const user = rtm.dataStore.getUserByName(name);
    if (!user) {
      rtm.sendMessage(`failed. unknown user ${name}`, msgChannelId);
      return true;
    }

    delete config.users[name];
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage('ok', msgChannelId);
    return true;
  }
  return false;
}

//-----------------------------------------------------------
function checkUserAtSkud(username, callback) {
  const check = spawn('skud', [username]);
  let output = '';

  check.stdout.on('data', (data) => {
    output += data;
  });

  check.stderr.on('data', (data) => {
    output += data;
  });

  check.on('close', (code) => {
    callback(output === '' ? 'Не найдено. Имена и фамилии, пишутся с большой буквы.' : `\`\`\`${output}\`\`\``);
  });
}

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

