const util = require('util');
const https = require('https');
const WebSocketClient = require('websocket').client;

const request = util.promisify(https.request);

let BOT_ID;

let wsClient;

const loopApiHost = process.env.LOOP_API_HOST;
const loopApiToken = process.env.LOOP_API_TOKEN;

const globalRequestOptions = {
    hostname: loopApiHost,
    port: 443,
    path: '',
    method: 'GET',
    headers: {
        Authorization: `Bearer ${loopApiToken}`,
        'content-encoding': 'application/json',
        Accept: 'application/json',
    }
};

let websocketOnline = false;
function  wsIsConnected() {
    return websocketOnline;
}
const reconnectTime = 5000;
function wsIntConnectCommand() {
    wsClient.connect(`wss://${loopApiHost}/api/v4/websocket`, null, null, {
        Authorization: `Bearer ${loopApiToken}`,
    });
}

function wsConnect(eventHandler) {
    if (!eventHandler || !(eventHandler instanceof Function)) {
        console.error('No event handler specified');
        return
    }

    wsClient = new WebSocketClient();
    // console.log(wsClient);
    wsClient.on('connectFailed', function (error) {
        console.error('Connect Error: ', error);
        setTimeout(wsIntConnectCommand, reconnectTime);
    });

    wsClient.on('connect', function (connection) {
        console.log('WebSocket Client Connected');
        websocketOnline = true;
        connection.on('error', function (error) {
            console.log("Connection Error: " + error.toString());
        });

        connection.on('close', function () {
            console.log('Connection Closed');
            websocketOnline = false;
            setTimeout(wsIntConnectCommand, reconnectTime);
        });

        connection.on('message', function (message) {
            if (message.type === 'utf8') {
                //console.log("Received: '" + message.utf8Data + "'");
                try {
                    const event = JSON.parse(message.utf8Data);

                    if (event.event == 'hello') {
                        BOT_ID = event.broadcast.user_id;
                        console.log('BOT_ID:', event.broadcast.user_id);
                    }
                    else if (event.event == 'posted') {
                        event.data.post = JSON.parse(event.data.post);

                        if (event.data.post.user_id == BOT_ID) {
                            // no action on bot own messages
                            return;
                        }
                    }

                    eventHandler(event);
                    // console.log(event);
                } catch (err) {
                    console.log('ws_on_message_error', err);
                }
            }
        });
    });

    wsIntConnectCommand();
}

async function sendCommand(options, data) {
    console.debug('REQ>', options.path, JSON.stringify(data));
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            console.log('RES statusCode:', res.statusCode);
            // console.log('RES headers:', res.headers);
            let responseData = '';

            res.on('data', (d) => {
                process.stdout.write(d);
                responseData += d;
            });

            res.on('end', (d) => {
                let responseDataFinal;
                if (responseData !== '') {
                    try {
                        responseDataFinal = JSON.parse(responseData);
                    } catch (err) {
                        responseDataFinal = responseData;
                    }
                }

                resolve({
                    statusCode: res.statusCode,
                    data: responseDataFinal,
                });
            });
        });

        req.on('error', (err) => {
            console.error('reqeust error:', err);
            reject(err);
        });

        req.end(data !== undefined && JSON.stringify(data));
    });
}

async function sendMessage(text, channel_id) {
    await sendCommand({
        ...globalRequestOptions,
        path: '/api/v4/posts',
        method: 'POST',
    }, {
        channel_id: channel_id,
        message: text,
    });
}

async function sendDirectMessage(text, user_id) {
    const channelId = await getDirectMsgChannelId(user_id);
    await sendCommand({
        ...globalRequestOptions,
        path: '/api/v4/posts',
        method: 'POST',
    }, {
        channel_id: channelId,
        message: text,
    });
}

async function getDirectMsgChannelId(user_id) {
    if (!BOT_ID) {
        const me = await sendCommand({
            ...globalRequestOptions,
            path: '/api/v4/users/me',
        });

        if (me && me.data && me.data.id) {
            BOT_ID = me.data.id;
        } else {
            console.error('sendDirectMessage, cannot aquire bot id:', err);
            throw new Error('ERR_NO_BOT_ID');
        }
    }

    const resp = await sendCommand({
        ...globalRequestOptions,
        path: '/api/v4/channels/direct',
        method: 'POST',
    }, [
        user_id,
        BOT_ID,
    ]);

    if (!resp || resp.statusCode != 201 || !resp.data.id) {
        console.error('Cannot find direct channel', err, resp);
        throw new Error('ERR_NO_DIRECT_CHANNEL');
    }
    return resp.data.id;
}

module.exports = {
    wsConnect,
    wsIsConnected,
    sendMessage,
    sendDirectMessage,
    getDirectMsgChannelId,
};
