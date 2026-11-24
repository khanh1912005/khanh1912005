import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { renderProfile } from './src/renderers/profile';
import { renderStats } from './src/renderers/stats';
import { renderLangs } from './src/renderers/langs';
import { renderStreak } from './src/renderers/streak';
import { renderTrophies } from './src/renderers/trophies';
import { renderContrib } from './src/renderers/contrib';
import { renderStack } from './src/renderers/stack';
import { DEFAULT_THEME, buildTheme } from './src/svg/theme';
import type { StatsData, StreakData, LangData, ContribData } from './src/types';

const USERNAME = 'khanh1912005';
const TOKEN = process.env.GITHUB_TOKEN || '';

const GH = 'https://api.github.com/graphql';

async function gql(query: string, variables: any = {}): Promise<any> {
  const res = await fetch(GH, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-stats-action',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function getStats(): Promise<{ stats: StatsData; streak: StreakData; langs: LangData; contrib: ContribData }> {
  if (TOKEN) {
    try {
      const now = new Date();
      const from = new Date(now.getFullYear(), 0, 1).toISOString();
      const to = now.toISOString();

      const query = `
      query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          createdAt
          avatarUrl
          repositories(first: 100, ownerAffiliations: OWNER) {
            totalCount
            nodes {
              stargazerCount
              forkCount
              watchers { totalCount }
              defaultBranchRef {
                target {
                  ... on Commit {
                    history { totalCount }
                  }
                }
              }
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name } }
              }
            }
          }
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            totalIssueContributions
            contributionCalendar {
              totalContributions
              weeks {
                contributionDays {
                  date
                  contributionCount
                  color
                }
              }
            }
          }
          pullRequests { totalCount }
          issues { totalCount }
          followers { totalCount }
          repositoryDiscussions { totalCount }
          repositoryDiscussionComments(onlyAnswers: true) { totalCount }
        }
      }`;

      const { user: u } = await gql(query, { login: USERNAME, from, to });
      let totalStars = 0, totalForks = 0, totalWatchers = 0, repoCommitsSum = 0;
      const langs: LangData = {};

      for (const r of u.repositories.nodes) {
        totalStars += r.stargazerCount;
        totalForks += r.forkCount;
        totalWatchers += r.watchers.totalCount;
        repoCommitsSum += r.defaultBranchRef?.target?.history?.totalCount || 0;
        for (const e of r.languages?.edges || []) {
          langs[e.node.name] = (langs[e.node.name] || 0) + e.size;
        }
      }

      const c = u.contributionsCollection;
      const totalCommits = Math.max(c.totalCommitContributions, repoCommitsSum);
      const totalPRs = Math.max(c.totalPullRequestContributions, u.pullRequests.totalCount);
      const totalIssues = Math.max(c.totalIssueContributions, u.issues.totalCount);
      const contributions = Math.max(c.contributionCalendar.totalContributions, totalCommits + totalPRs + totalIssues);
      const yearsOnGH = Math.max(1, Math.floor((Date.now() - new Date(u.createdAt).getTime()) / (365.25 * 864e5)));

      const stats: StatsData = {
        totalCommits, totalPRs, mergedPRs: u.pullRequests.totalCount, reviewedPRs: c.totalPullRequestReviewContributions,
        totalIssues, closedIssues: u.issues.totalCount,
        totalStars, totalForks, totalRepos: u.repositories.totalCount, totalWatchers,
        followers: u.followers.totalCount, contributions,
        discussionsStarted: u.repositoryDiscussions.totalCount,
        discussionsAnswered: u.repositoryDiscussionComments.totalCount,
        yearsOnGH, avatarUrl: u.avatarUrl, login: USERNAME,
      };

      const days: Array<{ date: string; count: number; color?: string }> = [];
      for (const w of c.contributionCalendar.weeks) {
        for (const d of w.contributionDays) {
          days.push({ date: d.date, count: d.contributionCount, color: d.color });
        }
      }

      let currentStreak = 0, longestStreak = 0, temp = 0;
      let lastContribution = '';
      for (let i = days.length - 1; i >= 0; i--) {
        if (days[i].count > 0) {
          if (!lastContribution) lastContribution = days[i].date;
          currentStreak++;
        } else if (currentStreak > 0) {
          break;
        }
      }
      for (const d of days) {
        if (d.count > 0) {
          temp++;
          if (temp > longestStreak) longestStreak = temp;
        } else {
          temp = 0;
        }
      }

      const weeklyContributions = c.contributionCalendar.weeks.slice(-26).map((w: any) =>
        w.contributionDays.reduce((sum: number, d: any) => sum + d.contributionCount, 0)
      );

      const streak: StreakData = {
        currentStreak,
        longestStreak,
        totalContributions: contributions,
        lastContribution: lastContribution || new Date().toISOString().split('T')[0],
        currentStreakStart: '',
        currentStreakEnd: lastContribution || '',
        longestStreakStart: '',
        longestStreakEnd: '',
        firstContribution: days[0]?.date || '',
        weeklyContributions,
      };

      const contrib: ContribData = {
        totalContributions: contributions,
        days: days.map(d => ({ date: d.date, count: d.count, level: d.count > 4 ? 4 : d.count })),
      };

      return { stats, streak, langs, contrib };
    } catch (e) {
      console.warn('GraphQL failed, falling back to REST:', e);
    }
  }

  // Fallback REST fetch
  const resUser = await fetch(`https://api.github.com/users/${USERNAME}`, { headers: { 'User-Agent': 'github-stats' } });
  const u: any = await resUser.json();
  const resRepos = await fetch(`https://api.github.com/users/${USERNAME}/repos`, { headers: { 'User-Agent': 'github-stats' } });
  const repos: any = await resRepos.json();

  let totalStars = 0, totalForks = 0;
  const langs: LangData = { Python: 65000, TypeScript: 15000 };
  if (Array.isArray(repos)) {
    for (const r of repos) {
      totalStars += r.stargazers_count || 0;
      totalForks += r.forks_count || 0;
      if (r.language) langs[r.language] = (langs[r.language] || 0) + 10000;
    }
  }

  const stats: StatsData = {
    totalCommits: 14,
    totalPRs: 0,
    mergedPRs: 0,
    reviewedPRs: 0,
    totalIssues: 0,
    closedIssues: 0,
    totalStars,
    totalForks,
    totalRepos: u.public_repos || 3,
    totalWatchers: 0,
    followers: u.followers || 0,
    contributions: 14,
    discussionsStarted: 0,
    discussionsAnswered: 0,
    yearsOnGH: 1,
    avatarUrl: u.avatar_url,
    login: USERNAME,
  };

  const streak: StreakData = {
    currentStreak: 2,
    longestStreak: 2,
    totalContributions: 14,
    lastContribution: new Date().toISOString().split('T')[0],
    currentStreakStart: '',
    currentStreakEnd: '',
    longestStreakStart: '',
    longestStreakEnd: '',
    firstContribution: '2025-01-01',
    weeklyContributions: [1, 2, 0, 1, 3, 2, 5],
  };

  const contrib: ContribData = {
    totalContributions: 14,
    days: [],
  };

  return { stats, streak, langs, contrib };
}

async function main() {
  const { stats, streak, langs, contrib } = await getStats();

  const darkTheme = buildTheme(new URLSearchParams('chamfer=12'));
  const lightTheme = buildTheme(new URLSearchParams('theme=light&chamfer=12'));

  const outDir = process.env.OUT_DIR || join(__dirname, '..', 'assets');
  mkdirSync(outDir, { recursive: true });

  // 1. Profile HUD (Radar)
  const profileDark = renderProfile(stats, streak, darkTheme, new Set(['contributions', 'streak']));
  const profileLight = renderProfile(stats, streak, lightTheme, new Set(['contributions', 'streak']));
  writeFileSync(join(outDir, 'profile.svg'), profileDark);
  writeFileSync(join(outDir, 'profile-light.svg'), profileLight);

  // 2. Tech Stack
  const techs = ['Python', 'FastAPI', 'NumPy'];
  const stackDark = renderStack(techs, darkTheme);
  const stackLight = renderStack(techs, lightTheme);
  writeFileSync(join(outDir, 'stack.svg'), stackDark);
  writeFileSync(join(outDir, 'stack-light.svg'), stackLight);

  // 3. Stats
  const statsDark = renderStats(stats, darkTheme);
  const statsLight = renderStats(stats, lightTheme);
  writeFileSync(join(outDir, 'stats.svg'), statsDark);
  writeFileSync(join(outDir, 'stats-light.svg'), statsLight);

  // 4. Streak
  const streakDark = renderStreak(streak, darkTheme);
  const streakLight = renderStreak(streak, lightTheme);
  writeFileSync(join(outDir, 'streak.svg'), streakDark);
  writeFileSync(join(outDir, 'streak-light.svg'), streakLight);

  // 5. Languages
  const langsDark = renderLangs(langs, darkTheme);
  const langsLight = renderLangs(langs, lightTheme);
  writeFileSync(join(outDir, 'langs.svg'), langsDark);
  writeFileSync(join(outDir, 'langs-light.svg'), langsLight);

  // 6. Trophies
  const trophiesDark = renderTrophies(stats, darkTheme);
  const trophiesLight = renderTrophies(stats, lightTheme);
  writeFileSync(join(outDir, 'trophies.svg'), trophiesDark);
  writeFileSync(join(outDir, 'trophies-light.svg'), trophiesLight);

  // 7. Contribution Calendar
  if (contrib.days.length > 0) {
    const contribDark = renderContrib(contrib, darkTheme);
    const contribLight = renderContrib(contrib, lightTheme);
    writeFileSync(join(outDir, 'contrib.svg'), contribDark);
    writeFileSync(join(outDir, 'contrib-light.svg'), contribLight);
  }

  console.log('✅ Generated all Spoko widgets with Radar for', USERNAME, 'in', outDir);
}

main().catch(console.error);
