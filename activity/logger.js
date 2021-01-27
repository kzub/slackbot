const winston = require('winston');
const { format } = require('logform');

require('winston-daily-rotate-file');

const logFilePath = process.env.LOGFILEPATH;

const consoleFormat = (name) => format.combine(
  format.colorize(),
  format.timestamp(),
  format.printf(info => {
    if (typeof info.message === 'object') {
      info.message = JSON.stringify(info.message, undefined, 2);
    }
    return `${info.timestamp} ${name} [${info.level}]: ${info.message}`;
  })
);

const jsonFormat = (name) => format.combine(
  format.timestamp(),
  format.printf(info => {
    if (typeof info.message === 'object') {
      info.data = JSON.stringify(info.message, undefined, 2);
      delete info.message;
    }
    return JSON.stringify({
      name: name,
      ...info,
    });
  }),
);

let logTransport;
if (logFilePath) {
  logTransport = new (winston.transports.DailyRotateFile)({
    filename: `${logFilePath}slack_activity_%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '5d'
  });
} else {
  logTransport = new winston.transports.Console();
}


const create = (name = '') => {
  let format;

  if (logFilePath) {
    format = jsonFormat(name);
  } else {
    format = consoleFormat(name);
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