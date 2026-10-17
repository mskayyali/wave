import { version } from '../../package.json';

/** Wave's version. package.json holds it; tauri.conf.json reads it from there. */
export const APP_VERSION = version;
