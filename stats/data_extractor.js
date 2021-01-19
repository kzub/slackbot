const puppeteer = require('puppeteer');
const fs = require('fs');
const log = require('./logger').create('EXTRACTOR');

const { slackDomain, slackLogin, slackPassword } = process.env;
if (!slackDomain || !slackLogin || !slackPassword) {
  throw new Error('slack variables not configured');
}

const getCurrentDate = () => {
  return new Date().toJSON().slice(0,10);
};

const slackDoLogin = async (page) => {
  // login
  await page.goto(`https://${slackDomain}.slack.com`);
  await page.waitForSelector('#email')
  await page.click('#email');
  await page.keyboard.type(slackLogin);
  await page.click('#password');
  await page.keyboard.type(slackPassword);
  await page.click('#signin_btn')
  await page.waitForRequest(r => r.url().startsWith('https://app.slack.com/client/'));
};

const allTimeMode = {
  bodyCheck: new RegExp(/date_range...all/gmis),
  selector: 'context_menu_item_1'
};
const p30dTimeMode = {
  bodyCheck: new RegExp(/date_range...30d/gmis),
  selector: 'context_menu_item_0'
};

const slackLoadStat = async (page, type, mode) => {
  let activityTick = 0;
  let scrollingStarted = false;
  const statsData = [];

  const responseHandler = async response => {
    // log.i(response.url(), response.status());
    if(response.url().toLowerCase().includes(`.slack.com/api/team.stats.list`)) {
      log.i('!!!!!!!! detected list', response.url());
      if (mode.bodyCheck.test(response.request().postData())) {
        log.i('!!!!!!!! not required mode, skip it');
        return
      }

      statsData.push(await response.json());

      activityTick = 0;
      if (!scrollingStarted) {
        log.i('!!!!!!!!!! start scrolling');
        scrollingStarted = true;
        page.$eval('#page_contents .ent_data_table__scrollable', table => {
          setInterval(function() {
            table.scrollBy(0, 50);
          }, 25);
        });
      }
    }
  };

  page.on('response', responseHandler);

  await page.goto(`https://${slackDomain}.slack.com/admin/stats#${type}`);
  // load stat table
  await page.waitForSelector('#page_contents .ent_data_table__scrollable')
  await page.waitForSelector('#page_contents .ent_date_picker_btn');
  await page.click('#page_contents .ent_date_picker_btn');
  await page.waitForSelector(`li[data-qa=${mode.selector}]`);
  await page.click(`li[data-qa=${mode.selector}]`);

  const finish = new global.Promise((resolve) => {
    const checkIntervalId = setInterval(async () => {
      activityTick++;
      log.i('tick:', activityTick);
      if (activityTick > 15) {
        log.i('stopped because of inactivity')
        clearInterval(checkIntervalId);
        resolve();
      }
    }, 1000);
  });
  await finish;
  page.off('response', responseHandler);
  return statsData;
};

const extract = async () => {
  const browser = await puppeteer.launch({
    headless: false,
    slowMo: 10,
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 1024,
    height: 768,
    deviceScaleFactor: 1,
  });

  await slackDoLogin(page);

  const channels1 = await slackLoadStat(page, 'channels', p30dTimeMode);
  const channels2 = await slackLoadStat(page, 'channels', allTimeMode);
  const members1 = await slackLoadStat(page, 'members', p30dTimeMode);
  const members2 = await slackLoadStat(page, 'members', allTimeMode);

  log.i(`writing data...`);
  fs.writeFileSync(`${getCurrentDate}-members1.json`, JSON.stringify(members1, null, 2));
  fs.writeFileSync(`${getCurrentDate}-members2.json`, JSON.stringify(members2, null, 2));
  fs.writeFileSync(`${getCurrentDate}-channels1.json`, JSON.stringify(channels1, null, 2));
  fs.writeFileSync(`${getCurrentDate}-channels2.json`, JSON.stringify(channels2, null, 2));
  await browser.close();
};

module.exports = {
  extract
}