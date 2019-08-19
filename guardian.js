const slack = require('@slack/rtm-api');
const fs = require('fs');
const request = require('request');

const token = process.env.SLACK_API_TOKEN;
const token2 = process.env.SLACK_API_TOKEN_LEGACY;
const configName = 'guardian.conf';

const rtm = new slack.RTMClient(token, {
  logLevel: slack.LogLevel.INFO
});

rtm.start();

rtm.on('connected', () => {
  console.log('RTM client authenticated!', new Date());
});

const config = JSON.parse(fs.readFileSync(configName));

//-----------------------------------------------------------
async function getSlackUser(userId) {
  const res = await rtm.webClient.users.info({ user: userId });
  if (!res.ok) {
    return null;
  }
  return res.user.name;
}


//-----------------------------------------------------------
async function getSlackUserByName(name) {
  let oneMoreStep = true;
  let members = [];

  for (let res ; oneMoreStep == true;) {
    res = await rtm.webClient.users.list({
      // limit: 500,
      cursor:  res && res.response_metadata.next_cursor
    });
    if (!res.ok) {
      return null;
    }
    members = members.concat(res.members);
    // console.log(res.members.length, res.response_metadata.next_cursor, oneMoreStep)
    oneMoreStep = res.response_metadata.next_cursor && res.response_metadata.next_cursor.length > 0;
  }

  // console.log(`TOTAL USERS: ${members.length}`);
  const user = members.filter(m => m.name == name).pop();
  return user && user.id;
}


async function getSlackChannelByName(name) {
  let oneMoreStep = true;
  let channels = [];
  for (let res ; oneMoreStep == true;) {
    res = await rtm.webClient.channels.list({
      exclude_archived: true,
      // limit: 500,
      cursor:  res && res.response_metadata.next_cursor
    });
    if (!res.ok) {
      return null;
    }
    channels = channels.concat(res.channels);
    // console.log(res.channels.length, res.response_metadata.next_cursor, oneMoreStep)
    oneMoreStep = res.response_metadata.next_cursor && res.response_metadata.next_cursor > 0;
  }

  // console.log(`TOTAL CHANNELS: ${channels.length}`);
  const channel = channels.filter(m => m.name == name).pop();
  return channel && channel.id;
}


//-----------------------------------------------------------
async function getSlackChannel(channelId) {
  const res = await rtm.webClient.conversations.info({ channel: channelId });
  if (!res.ok) {
    return null;
  }
  return res.channel.name;
}


async function processAdminMessage(message, msgChannelId) {
  const parts = message.split(' ');
  const [cmd, channel, name]  = parts;

  if (cmd === 'add' || cmd === 'addId') {
    if (cmd === 'add') {
      const user = await getSlackUserByName(name);
      if (!user) {
        console.log('not found user:', name, user)
        rtm.sendMessage(`failed. unknown user ${name}`, msgChannelId);
        return;
      }
    } else {
      const user = await getSlackUser(name);
      if (!user) {
        console.log('not found userId:', name, user)
        rtm.sendMessage(`failed. unknown userId ${name}`, msgChannelId);
        return;
      }
    }
    const channelId = await getSlackChannelByName(channel);
    if (!channelId) {
      rtm.sendMessage(`failed. unknown channel ${channel}`, msgChannelId);
      return;
    }

    if (!config.protect[channel]) {
      config.protect[channel] = {};
    }
    config.protect[channel][name] = true;
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage('ok', msgChannelId);
  }

  else if (cmd === 'list') {
    const msg = [];
    for (const chan in config.protect) {
      for (const usr in config.protect[chan]) {
        msg.push([chan, usr].join(' '));
      }
    }
    rtm.sendMessage(msg.join('\n'), msgChannelId);
  }

  else if (cmd === 'del' || cmd === 'rem') {
    const user = await getSlackUserByName(name);
    if (!user) {
      rtm.sendMessage(`failed. unknown user ${name}`, msgChannelId);
      return;
    }
    const channelId = await getSlackChannelByName(channel);
    if (!channelId) {
      rtm.sendMessage(`failed. unknown channel ${channel}`, msgChannelId);
      return;
    }

    delete config.protect[channel][name];
    if (Object.keys(config.protect[channel]).length === 0) {
      delete config.protect[channel];
    }
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage('ok', msgChannelId);
  }
}

rtm.on('message', async (message) => {
  try {
    if (!message.user || !message.text) {
      return;
    }

    const slackuser = await getSlackUser(message.user);
    if (!slackuser) {
      console.log('error getting slackuser', message);
      return;
    }
    const channel = await getSlackChannel(message.channel);
    if (!channel) {
      if (config.admins[slackuser]) {
        await processAdminMessage(message.text, message.channel);
        return;
      }
      console.log('error getting channel', message);
      return;
    }
    console.log(channel, slackuser, `thread:${Boolean(message.thread_ts)}`, message.text);

    if (!config.protect[channel] || config.protect[channel][slackuser] || message.thread_ts /* threads allowed */) {
      return;
    }

    console.log('DELETE MESSAGE ^^^');
    let url =  `https://slack.com/api/chat.delete?token=${token2}`;
    url += `&ts=${message.ts}`;
    url += `&channel=${message.channel}`;
    url += '&as_user=true&pretty=1';

    request(url, (err) => {
      if (err) {
        console.log(err);
      }
    });
  } catch (err) {
    console.error(err, err.stack);
  }
});

