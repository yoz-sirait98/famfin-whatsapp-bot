const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer to a non-hidden folder
  cacheDirectory: join(__dirname, 'puppeteer-cache'),
};
