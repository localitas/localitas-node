const APP_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Throw a TypeError unless name is an app name. */
function checkAppName(name) {
  if (typeof name !== 'string' || !APP_NAME.test(name)) {
    throw new TypeError(`app name ${JSON.stringify(name)} must match ${APP_NAME}`);
  }
  return name;
}

/** Throw a TypeError unless p is a path on an app, never an address. */
function checkAppPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) {
    throw new TypeError(`app path ${JSON.stringify(p)} must start with a single "/"`);
  }
  if (p.includes('\\') || p.split('?')[0].includes('://')) {
    throw new TypeError(`app path ${JSON.stringify(p)} must be a path, not an address`);
  }
  return p;
}

module.exports = { checkAppName, checkAppPath };
