import { describe, expect, it } from 'vitest';
import { isApp, isTvApp } from '@/lib/appBridge';

const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

describe('détection de l’application Android', () => {
  it('navigateur ordinaire : ni appli ni TV', () => {
    expect(isApp(CHROME)).toBe(false);
    expect(isTvApp(CHROME)).toBe(false);
  });
  it('appli sur téléphone', () => {
    const ua = `${CHROME} BasketLandApp/1.2.0`;
    expect(isApp(ua)).toBe(true);
    expect(isTvApp(ua)).toBe(false);
  });
  it('appli sur TV (Fire TV, Google TV)', () => {
    const ua = `${CHROME} BasketLandApp/0.1.0-dev; TV`;
    expect(isApp(ua)).toBe(true);
    expect(isTvApp(ua)).toBe(true);
  });
});
