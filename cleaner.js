const slack = require('@slack/rtm-api');
const { WebClient } = require('@slack/web-api');

const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

// #################################################################
const channelToClean = '';
const userToClean = '';
const cleanSinceTime = (new Date('2020-09-15T00:00:00Z').valueOf()) / 1000;
// #################################################################

const rtm = new slack.RTMClient(process.env.SLACK_API_TOKEN, {
  logger: {
    debug: (...msgs) => { /*console.log(`RTM[DEBUG]: ${JSON.stringify(msgs)}`);*/ },
    info: (...msgs) =>  { console.log(`RTM[INFO]: ${JSON.stringify(msgs)}`);  },
    warn: (...msgs) =>  { console.log(`RTM[WARN]: ${JSON.stringify(msgs)}`);  },
    error: (...msgs) => { console.log(`RTM[ERROR]: ${JSON.stringify(msgs)}`); },
    setLevel: () => { },
    setName:  () => { },
  },
  clientPingTimeout: 120000,
  serverPongTimeout: 60000,
});

rtm.start();

const web = new WebClient(process.env.SLACK_WEBAPI_TOKEN, {
  logger: {
    debug: (...msgs) => { /*console.log(`RTM[DEBUG]: ${JSON.stringify(msgs)}`);*/ },
    info: (...msgs) =>  { console.log(`RTM[INFO]: ${JSON.stringify(msgs)}`);  },
    warn: (...msgs) =>  { console.log(`RTM[WARN]: ${JSON.stringify(msgs)}`);  },
    error: (...msgs) => { console.log(`RTM[ERROR]: ${JSON.stringify(msgs)}`); },
    setLevel: () => { },
    setName:  () => { },
  },
});

rtm.on('connected', async () => {
  console.log('RTM client authenticated!', new Date());

  const result = await rtm.webClient.conversations.history({
    channel: channelToClean,
    oldest: cleanSinceTime,
    limit: 1000,
  });

  let cleaned = 0;
  for (let id in result. messages) {
    const message = result. messages[id];

    if (message.username !== userToClean) {
      continue;
    }

    console.log(`DELETE MESSAGE ^^^, ${message.ts}: ${message.text}`);
    cleaned++;
    await web.chat.delete({
      ts: message.ts,
      channel,
    }).catch(err => {
      console.log('ERROR DELETE MESSAGE:', err.data);
    })

    await sleep(3000);
  }

  console.log(cleaned, 'of', result.messages.length, 'messages are cleaned');
  process.exit();
});

//-----------------------------------------------------------
process.on('unhandledRejection', function(reason, p){
  console.log('unhandledRejection', reason, p);
});

process.on('uncaughtException', function(error) {
  console.log('uncaughtException', error);
});


