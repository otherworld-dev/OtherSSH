import type { SessionProfile } from './types';

export interface ProfileGroup {
  name: string;
  profiles: SessionProfile[];
}

export interface GroupedProfiles {
  /** Sessions with no group, shown first without a header. */
  ungrouped: SessionProfile[];
  /** Groups A to Z, each with its sessions A to Z. */
  groups: ProfileGroup[];
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function profileMatches(profile: SessionProfile, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [profile.name, profile.host, profile.user ?? '', profile.group ?? ''].some((s) => s.toLowerCase().includes(q));
}

export function groupProfiles(profiles: SessionProfile[], query = ''): GroupedProfiles {
  const ungrouped: SessionProfile[] = [];
  const byGroup = new Map<string, SessionProfile[]>();
  for (const profile of profiles) {
    if (!profileMatches(profile, query)) continue;
    const group = profile.group?.trim() ?? '';
    if (!group) {
      ungrouped.push(profile);
      continue;
    }
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(profile);
    else byGroup.set(group, [profile]);
  }
  ungrouped.sort(byName);
  const groups = [...byGroup].map(([name, list]) => ({ name, profiles: list.sort(byName) })).sort(byName);
  return { ungrouped, groups };
}

export function groupNames(profiles: SessionProfile[]): string[] {
  return groupProfiles(profiles).groups.map((g) => g.name);
}
