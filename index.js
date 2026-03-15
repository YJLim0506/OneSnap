/**
 * @format
 */

// Firebase Storage needs atob/btoa (base64) in React Native. Polyfill before any Firebase code.
import { decode as base64Decode, encode as base64Encode } from 'base-64';
if (typeof global.atob === 'undefined') {
  global.atob = base64Decode;
}
if (typeof global.btoa === 'undefined') {
  global.btoa = base64Encode;
}

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
