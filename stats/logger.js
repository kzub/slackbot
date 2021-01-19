const getDateObj = (ts) => {
  return new Date(ts);
};

const getDateAndTime = (ts) => {
  return getDateObj(ts).toJSON().slice(0, 19);
};

module.exports = {
  create: (name) => {
    return {
      i: (...rest) => {
        console.log(getDateAndTime(Date.now()), `[\u001b[33m${name}\u001b[0m]\u001b[32m[I]\u001b[0m`, ...rest);
      },
      e: (...rest) => {
        console.log('\u001b[31m' + getDateAndTime(Date.now()), `[${name}][E]`, ...rest, '\u001b[0m');
      }
    };
  }
};