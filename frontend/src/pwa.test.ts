import { describe, expect, it } from 'vitest';
import { shouldRegisterPwa } from './pwa';

describe('PWA registration policy', () => {
  it('registers only for a production HTTP(S) browser', () => {
    expect(shouldRegisterPwa(true, 'https:', true)).toBe(true);
    expect(shouldRegisterPwa(true, 'http:', true)).toBe(true);
    expect(shouldRegisterPwa(false, 'https:', true)).toBe(false);
    expect(shouldRegisterPwa(true, 'file:', true)).toBe(false);
    expect(shouldRegisterPwa(true, 'https:', false)).toBe(false);
  });
});
