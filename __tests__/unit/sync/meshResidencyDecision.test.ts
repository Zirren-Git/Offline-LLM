import { needsMeshResidency } from '../../../pro/sync/meshResidency';

describe('mesh background residency', () => {
  const idle = {
    running: true,
    connected: false,
    discoverable: false,
    discovering: false,
  };

  it('does not hold residency for an idle mesh', () => {
    expect(needsMeshResidency(idle)).toBe(false);
  });

  it.each(['connected', 'discoverable', 'discovering'] as const)(
    'holds residency while %s',
    activity => {
      expect(needsMeshResidency({ ...idle, [activity]: true })).toBe(true);
    },
  );

  it('does not hold residency after sync stops', () => {
    expect(needsMeshResidency({ ...idle, running: false, connected: true })).toBe(false);
  });
});
