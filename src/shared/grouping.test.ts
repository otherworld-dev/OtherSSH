import { describe, it, expect } from 'vitest';
import { groupProfiles, groupNames, profileMatches } from './grouping';
import type { SessionProfile } from './types';

const p = (name: string, group?: string, extra: Partial<SessionProfile> = {}): SessionProfile => ({
  id: name.toLowerCase(),
  name,
  host: `${name.toLowerCase()}.example`,
  ...(group ? { group } : {}),
  ...extra,
});

const all = [p('Zeta', 'Work'), p('alpha'), p('Beta', 'Home'), p('gamma', 'Work'), p('Delta')];

describe('groupProfiles', () => {
  it('lists ungrouped sessions first, sorted by name ignoring case', () => {
    const { ungrouped } = groupProfiles(all);
    expect(ungrouped.map((x) => x.name)).toEqual(['alpha', 'Delta']);
  });

  it('sorts groups A to Z and the sessions inside each group by name', () => {
    const { groups } = groupProfiles(all);
    expect(groups.map((g) => g.name)).toEqual(['Home', 'Work']);
    expect(groups[1]!.profiles.map((x) => x.name)).toEqual(['gamma', 'Zeta']);
  });

  it('treats a whitespace-only group as ungrouped and trims real ones', () => {
    const { ungrouped, groups } = groupProfiles([p('A', '   '), p('B', ' Ops ')]);
    expect(ungrouped.map((x) => x.name)).toEqual(['A']);
    expect(groups).toEqual([{ name: 'Ops', profiles: [p('B', ' Ops ')] }]);
  });

  it('applies a filter and drops groups left empty by it', () => {
    const { ungrouped, groups } = groupProfiles(all, 'home');
    expect(ungrouped).toEqual([]);
    expect(groups.map((g) => g.name)).toEqual(['Home']);
    expect(groups[0]!.profiles.map((x) => x.name)).toEqual(['Beta']);
  });
});

describe('profileMatches', () => {
  it('matches case-insensitively on name, host, user and group', () => {
    const x = p('Box', 'Clients', { user: 'Alex' });
    expect(profileMatches(x, 'box')).toBe(true);
    expect(profileMatches(x, 'BOX.EXAMPLE')).toBe(true);
    expect(profileMatches(x, 'alex')).toBe(true);
    expect(profileMatches(x, 'client')).toBe(true);
    expect(profileMatches(x, 'nope')).toBe(false);
  });

  it('matches everything on a blank query', () => {
    expect(profileMatches(p('A'), '  ')).toBe(true);
  });
});

describe('groupNames', () => {
  it('returns the unique group names sorted A to Z', () => {
    expect(groupNames(all)).toEqual(['Home', 'Work']);
    expect(groupNames([p('A')])).toEqual([]);
  });
});
