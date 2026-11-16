// downloads.html#grab=12 → app.html#downloads/grab=12
const grab = location.hash.slice(1);
location.replace(browser.runtime.getURL(`/app.html#downloads${grab ? `/${grab}` : ''}`));
