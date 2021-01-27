const winston = require('winston');
const { format } = require('logform');

require('winston-daily-rotate-file');

const logFilePath = process.env.LOGFILEPATH;
const logJSON = process.env.LOGJSON;

const consoleFormat = () => format.combine(
  format.colorize(),
  format.timestamp(),
  format.printf(info => {
    if (typeof info.message === 'object') {
      info.message = JSON.stringify(info.message, undefined, 2);
    }
    return `${info.timestamp} [${info.level}]: ${info.message}`;
  })
);

const jsonFormat = () => format.combine(
  format.timestamp(),
  format.printf(info => {
    if (typeof info.message === 'object') {
      info.data = JSON.stringify(info.message, undefined, 2);
      delete info.message;
    }
    return JSON.stringify(info);
  }),
);

let logTransport;
if (logFilePath) {
  logTransport = new (winston.transports.DailyRotateFile)({
    filename: `${logFilePath}slackbot.activity.%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '5d'
  });
} else {
  logTransport = new winston.transports.Console();
}


const create = () => {
  let format;

  if (logJSON) {
    format = jsonFormat();
  } else {
    format = consoleFormat();
  }

  const logger = winston.createLogger({
    level: 'info',
    format,
    transports : [logTransport],
    exitOnError: false,
  });

  const publicLogger = {};
  for (let level in logger.levels) {
    publicLogger[level] = (...rest) => {
      return logger[level](...rest);
    };
  }
  return publicLogger;
};

module.exports = { create };