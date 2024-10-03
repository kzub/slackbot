const fs = require('fs');
const loop = require('./loop_api');

const BOT_NAME = process.env.BOT_NAME || 'zina';
const SERVERSLIST_DIR = 'servers';
const INFO_DIR = 'info';
const DEFAULT_CLIAM_TIME = 1000 * 60 * 60 * 24;
const CHECK_SERVERS_STATUS_INTERVAL = 1000 * 10;
const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID
const TSQ = "```";

let BOT_ID;

//-----------------------------------------------------------
process.on('unhandledRejection', function (reason, p) {
    console.log('unhandledRejection', reason, p);
});

process.on('uncaughtException', function (error) {
    console.log('uncaughtException', error);
});

//-----------------------------------------------------------
loop.wsConnect(function (event) {
    // console.log(event);
    if (event.event == 'hello') {
        // loop.sendDirectMessage('test message', 'useid')
    }

    if (event.event == 'posted') {
        handleLoopMessage(event.data.post.message, event.data.post.channel_id, event.data.post.user_id, event.data.sender_name, event.data.channel_type);
    }
})

//-----------------------------------------------------------
async function handleLoopMessage(message, channelId, userId, userName, channelType) {
    let context;

    try {
        if (!message || !userId) {
            return;
        }

        const data = await parseMessageCmd(message, channelType == 'D');
        if (!data) {
            return;
        }

        context = {
            loopUser: userName,
            loopUserDM: await loop.getDirectMsgChannelId(userId),
            sendMessage(msg) {
                loop.sendMessage(msg, channelId);
            },
        };

        switch (data.cmd) {
            case 'get':
                context.serverName = data.params[0];
                claimServer(context); break;
            case 'free':
                context.serverName = data.params[0];
                unClaimServer(context); break;
            case 'list':
                context.listOption = data.params[0];
                listServers(context); break;
            case 'help':
            default:
                printHelp(context);
        }
    } catch (err) {
        console.error(err, err.stack);
        const result = err.message || 'Internal error';
        context.sendMessage(`${userName} ${result}`);
    }
}

//-----------------------------------------------------------
function claimServer(context) {
    const state = readServerState(context.serverName);

    const currentTime = Date.now();
    if (state.valid_till_timestamp && context.loopUser !== state.owner) {
        if (currentTime < state.valid_till_timestamp) {
            context.sendMessage(`ERROR. ${context.serverName} is owned by ${state.owner} till ${TSQ}${getDateFromTimestamp(state.valid_till_timestamp)}${TSQ}`);
            return;
        }
    }

    const userchange = state.owner && state.owner !== context.loopUser;
    const lastOwner = state.owner;

    state.valid_till_timestamp = getClaimTimeRight(state._config);
    state.owner = context.loopUser;
    state.ownerDM = context.loopUserDM;

    writeServerState(state);

    let result = `${context.serverName} is yours ${state.owner} till ${TSQ}${getDateFromTimestamp(state.valid_till_timestamp)}${TSQ}`;
    if (userchange) {
        result += `\n${lastOwner} lost ownership\n`;
    }
    context.sendMessage(result);

    if (state._config.dynamic_bootstrap) {
        jenkinsCreateServer(context, state._config);
    }
}

//-----------------------------------------------------------
function unClaimServer(context) {
    const state = readServerState(context.serverName);
    const currentTime = Date.now();
    const expired = state.valid_till_timestamp < currentTime;
    const lastOwner = state.owner;

    if (!expired && state.owner && context.loopUser !== state.owner) {
        context.sendMessage(`ERROR. ${context.serverName} is owned by ${state.owner}`);
        return;
    }

    state.valid_till_timestamp = currentTime;
    state.owner = undefined;
    state.lastOwner = lastOwner;
    writeServerState(state);

    let result = `${context.serverName} is free`;
    if (lastOwner) {
        result += `\n${lastOwner} lost ownership`;
    }
    if (state._config.dynamic_bootstrap) {
        const destroyTime = Math.round(state._config.unclaim_to_destroy_time / 1000 / 60);
        result = `\nwill be destroyed after ${destroyTime} minutes of idle`;
    }
    context.sendMessage(result);
}

//-----------------------------------------------------------
function compareServerName(objA, objB) {
    if (objA._serverName < objB._serverName) {
        return -1;
    } else if (objA._serverName > objB._serverName) {
        return +1;
    }
    return 0;

}

//-----------------------------------------------------------
function listServers(context) {
    const states = readAllServersState();
    const result = [];
    const currentTime = Date.now();

    for (const state of states) {
        let dynamic = '';
        if (state._config.dynamic_bootstrap) {
            dynamic = ' (dynamic)';
        }
        if (state._config.team) {
            dynamic = `-${state._config.team}` + dynamic;
        }
        if (!state.valid_till_timestamp || state.valid_till_timestamp <= currentTime) {
            result.push(`${state._serverName}${dynamic} is free`);
        } else {
            if (context.listOption == 'free') { continue; }
            result.push(`${state._serverName}${dynamic} is owned by ${state.owner} till ${TSQ}${getDateFromTimestamp(state.valid_till_timestamp)}${TSQ}`);
        }
    }

    context.sendMessage(result.join('\n'));
}

//-----------------------------------------------------------
function printHelp(context) {
    context.sendMessage(`list
list free
get <server>
free <server>`);
}

//-----------------------------------------------------------
function checkServersLoop() {
    try {
        if (!loop.wsIsConnected()) {
            console.log('checkServersLoop: not connected...');
            return;
        }
        if (!BOT_CHANNEL_ID) {
            console.log('checkServersLoop: channel id not set');
            return;
        }

        const currentTime = Date.now();
        const states = readAllServersState();

        for (const state of states) {
            if (!state.valid_till_timestamp) {
                continue;
            }
            if (state.valid_till_timestamp < currentTime) {
                freeServerByBot(state, BOT_CHANNEL_ID);
            }
            if (state.valid_till_timestamp + state._config.unclaim_to_destroy_time < currentTime) {
                destroyServerByBot(state, BOT_CHANNEL_ID);
            }
        }
    } catch (err) {
        console.log('ERROR checkServersLoop()', err);
    }
}
setInterval(checkServersLoop, CHECK_SERVERS_STATUS_INTERVAL);

//-----------------------------------------------------------
function freeServerByBot(state, channelId) {
    if (state.owner) {
        const lastOwner = state.owner;
        const lastOwnerDM = state.ownerDM;
        state.lastOwner = state.owner;
        state.lastOwnerDM = state.ownerDM;
        state.owner = undefined;
        state.ownerDM = undefined;
        writeServerState(state);

        let destroyMsg = '';
        if (state._config.dynamic_bootstrap) {
            const destroyTime = Math.round(state._config.unclaim_to_destroy_time / 1000 / 60);
            destroyMsg = `\nwill be destroyed after ${destroyTime} minutes of idle`;
        }
        loop.sendMessage(`${state._serverName} released by bot\n${lastOwner} lost ownership${destroyMsg}`, channelId);
        if (lastOwnerDM) {
            // not a sendDirectMessage потому что канал lastOwnerDM уже просчитан на директ сообщение
            loop.sendMessage(`${state._serverName} released by bot${destroyMsg}`, lastOwnerDM);
        }
    }
}

//-----------------------------------------------------------
function readServerState(serverName) {
    const state = {};

    // config
    const serverFileName = [SERVERSLIST_DIR, serverName].join('/');
    try {
        state._config = JSON.parse(fs.readFileSync(serverFileName));
        state._serverName = serverName;
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Unknown server: ${serverName}`);
        }
        console.log('ERROR readServerState() config', serverFileName, err);
        throw new Error(`Internal error while reading: ${serverName}`);
    }

    // state
    const stateFileName = [INFO_DIR, serverName].join('/');
    try {
        const info = JSON.parse(fs.readFileSync(stateFileName));
        for (const key in info) {
            state[key] = info[key];
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.log('ERROR readServerState() state', stateFileName, err);
        }
    }

    return state;
}

//-----------------------------------------------------------
function readAllServersState() {
    const serversList = fs.readdirSync(SERVERSLIST_DIR);
    const result = [];

    for (const idx in serversList) {
        const serverName = serversList[idx];
        const state = readServerState(serverName);
        result.push(state);
    }

    result.sort(compareServerName);
    return result;
}

//-----------------------------------------------------------
function writeServerState(state) {
    const serverFileName = [INFO_DIR, state._serverName].join('/');
    const stateCopy = JSON.parse(JSON.stringify(state));
    delete stateCopy._config;
    delete stateCopy._serverName;
    fs.writeFileSync(serverFileName, JSON.stringify(stateCopy));
}

//-----------------------------------------------------------
async function parseMessageCmd(text, directChannel) {
    if (!text) {
        return null;
    }

    if (directChannel) {
        const parts = text.split(' ');

        return {
            cmd: parts[0].toLowerCase(),
            params: parts.slice(1),
        };
    }

    if (text.indexOf(BOT_NAME) !== 0) {
        return null;
    }

    const parts = text.split(' ');

    return {
        cmd: parts[1].toLowerCase(),
        params: parts.slice(2),
    };
}

//-----------------------------------------------------------
function getClaimTimeRight(config) {
    // до конца дня
    if (config.claim_till_day_end) {
        const dayEnd = new Date();
        dayEnd.setHours(23);

        // чтобы обойти лимиты slack на отпавку сообщений 1 в секунду.
        const randomMin = Math.floor(Math.random() * 59);
        const randomSec = Math.floor(Math.random() * 59);
        dayEnd.setMinutes(randomMin);
        dayEnd.setSeconds(randomSec);

        return dayEnd.valueOf();
    }

    // в конфиге задано количество времени (милисекунд) отведенных на владение
    if (isFinite(config.claim_time)) {
        return Date.now() + config.claim_time;
    }

    // режим по умолчанию
    const claimTime = new Date(Date.now() + DEFAULT_CLIAM_TIME);
    const dayOfWeek = claimTime.getDay();
    // weekends are not counted
    if (dayOfWeek === 0) { // воскресенье
        claimTime.setHours(claimTime.getHours() + 24);
    }
    else if (dayOfWeek === 6) { // суббота
        claimTime.setHours(claimTime.getHours() + 48);
    }
    return claimTime.valueOf();
}

//-----------------------------------------------------------
function getDateFromTimestamp(timestamp) {
    return `${new Date(timestamp).toJSON().slice(0, 19).replace('T', ' ')} (GMT)`;
}

