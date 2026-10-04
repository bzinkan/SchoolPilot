import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
export const applicationRoot = process.env.RELEASE297_APPLICATION_ROOT || '/app';
export const moduleFromApplication = name => import(pathToFileURL(resolve(applicationRoot, 'dist', name)).href);
export const requireFromApplication = createRequire(resolve(applicationRoot, 'package.json'));
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
