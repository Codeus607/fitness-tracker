<?php
// Monthly report, run from the command line (not reachable over the web, see .htaccess):
//   php report.php [YYYY-MM] [--send] [--html]
// Prints the report of that month (default: last month) as markdown (--html: the email's HTML instead).
// --send also emails it to REPORT_EMAIL (and from REPORT_FROM), defined in config.php.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
const FITNESS_CLI = true;
require __DIR__ . '/api.php';

// a month with fewer working sets than this for a body part is flagged
const LOW_SETS = 12;
// this many sessions in a row without beating the best before them = stalled
const STALL_SESSIONS = 3;

$args = array_slice($argv, 1);
$send = in_array('--send', $args, true);
$month = current(array_filter($args, fn($a) => preg_match('/^\d{4}-\d{2}$/', $a))) ?: date('Y-m', strtotime('first day of last month'));
$prev = date('Y-m', strtotime("$month-01 -1 month"));

// ---------- data ----------

$info = [];
foreach (exercises() as $g) foreach ($g['exercises'] as $e) $info[$e['name']] = $e + ['group' => $g['name']];
$infoOf = fn($name) => $info[$name] ?? ['name' => $name, 'group' => 'Other', 'timed' => false, 'bw' => false];
$groupNames = array_values(array_unique(array_column($info, 'group')));
$ws = workouts();
$inMonth = fn($w, $m) => str_starts_with($w['date'], $m);

// same ranking as the app: timed by seconds, bodyweight by extra weight then reps, otherwise Brzycki 1RM
function score(array $s, array $i): array
{
    return $i['timed'] ? [$s['reps'], $s['weight']]
        : ($i['bw'] ? [$s['weight'], $s['reps']] : [round(brzycki($s['weight'], $s['reps']), 1), $s['weight'], $s['reps']]);
}

function month_stats(array $ws, string $m, callable $infoOf, array $groupNames): array
{
    $st = ['workouts' => 0, 'days' => [], 'load' => 0.0, 'sets' => 0, 'minutes' => [], 'groups' => array_fill_keys($groupNames, ['sets' => 0, 'load' => 0.0])];
    foreach ($ws as $w) {
        if (!str_starts_with($w['date'], $m)) continue;
        $st['workouts']++;
        $st['days'][$w['date']] = true;
        if ($w['finished_at'] && $w['finished_at'] - $w['started_at'] < 6 * 3600) $st['minutes'][] = ($w['finished_at'] - $w['started_at']) / 60;
        foreach ($w['sets'] as $s) {
            if ($s['warmup']) continue;
            $i = $infoOf($s['exercise']);
            $l = $i['timed'] ? 0 : $s['reps'] * $s['weight'];
            $st['sets']++;
            $st['load'] += $l;
            $st['groups'][$i['group']] ??= ['sets' => 0, 'load' => 0.0];
            $st['groups'][$i['group']]['sets']++;
            $st['groups'][$i['group']]['load'] += $l;
        }
    }
    $st['days'] = count($st['days']);
    $st['avg_min'] = $st['minutes'] ? array_sum($st['minutes']) / count($st['minutes']) : 0;
    return $st;
}

$cur = month_stats($ws, $month, $infoOf, $groupNames);
$old = month_stats($ws, $prev, $infoOf, $groupNames);
$hasPrev = $old['workouts'] > 0;

// every session's best set per exercise, up to the end of the month
$sessions = [];
foreach ($ws as $w) {
    if ($w['date'] >= "$month-32") break;
    $byEx = [];
    foreach ($w['sets'] as $s) if (!$s['warmup']) $byEx[$s['exercise']][] = $s;
    foreach ($byEx as $ex => $sets) {
        $i = $infoOf($ex);
        $best = null;
        foreach ($sets as $s) if (!$best || score($s, $i) > score($best, $i)) $best = $s;
        $sessions[$ex][] = ['date' => $w['date'], 'best' => $best];
    }
}

// a PR is a session that beats everything logged before it (like the app), the first session never counts;
// per exercise: the best set of the month against the best before its first PR of the month
$prs = $new = $within = [];
foreach ($sessions as $ex => $list) {
    $i = $infoOf($ex);
    $best = null;
    foreach ($list as $x) {
        if (str_starts_with($x['date'], $month)) {
            if (!$best) $new[] = $ex;
            elseif (score($x['best'], $i) > score($best, $i)) {
                $prs[$ex]['was'] ??= $best;
                $prs[$ex]['now'] = ['set' => $x['best'], 'date' => $x['date']];
            }
            $within[$ex] = true;
        }
        if (!$best || score($x['best'], $i) > score($best, $i)) $best = $x['best'];
    }
}

// exercises done this month whose last STALL_SESSIONS sessions never beat the best before them
$stalled = [];
foreach ($sessions as $ex => $list) {
    if (!isset($within[$ex]) || count($list) <= STALL_SESSIONS) continue;
    $i = $infoOf($ex);
    $older = array_slice($list, 0, -STALL_SESSIONS);
    $best = array_reduce($older, fn($b, $x) => !$b || score($x['best'], $i) > score($b, $i) ? $x['best'] : $b);
    $recent = array_slice($list, -STALL_SESSIONS);
    if (array_filter($recent, fn($x) => score($x['best'], $i) > score($best, $i))) continue;
    $top = array_reduce($recent, fn($b, $x) => !$b || score($x['best'], $i) > score($b, $i) ? $x['best'] : $b);
    $stalled[$ex] = ['best' => $best, 'recent' => $top];
}

// program: workouts per week planned (days of the first program), and days not done this month
$programs = programs();
$plan = $programs[0] ?? null;
$daysInMonth = (int)date('t', strtotime("$month-01"));
$perWeek = $cur['workouts'] / ($daysInMonth / 7);
$doneDays = [];
foreach ($ws as $w) if ($inMonth($w, $month) && $w['plan'] !== '') $doneDays[$w['plan']] = ($doneDays[$w['plan']] ?? 0) + 1;

// longest break between two workouts in the month (including from the previous month's last one)
$dates = array_values(array_unique(array_map(fn($w) => $w['date'], array_filter($ws, fn($w) => $w['date'] < "$month-32"))));
$gap = ['days' => 0];
for ($k = 1; $k < count($dates); $k++) {
    if (!str_starts_with($dates[$k], $month)) continue;
    $d = (strtotime($dates[$k]) - strtotime($dates[$k - 1])) / 86400;
    if ($d > $gap['days']) $gap = ['days' => (int)$d, 'from' => $dates[$k - 1], 'to' => $dates[$k]];
}

// body weight: last entry of each month
$bwAt = function (string $m) {
    $last = null;
    foreach (bodyweight() as $b) if ($b['date'] < "$m-32") $last = $b;
    return $last && str_starts_with($last['date'], $m) ? (float)$last['kg'] : null;
};
$bwCur = $bwAt($month);
$bwOld = $bwAt($prev);

// ---------- helpers ----------

function month_label(string $m): string
{
    return date('F Y', strtotime("$m-15"));
}

function month_name(string $m): string
{
    return date('F', strtotime("$m-15"));
}

function planName(array $p, array $d): string
{
    return "{$p['name']} / {$d['name']}";
}

function kg(float $n): string
{
    return number_format($n, 0, '.', ' ') . ' kg';
}

function tonnes(float $n): string
{
    return fmt_num(round($n / 1000, 1)) . ' tonnes';
}

// change between two numbers: "+12%" (or "+0.4 kg" for small absolute values)
function delta(?float $now, ?float $was, string $unit = '%'): string
{
    if ($now === null || $was === null) return '';
    if ($unit !== '%') {
        $d = $now - $was;
        return ($d > 0 ? '+' : ($d < 0 ? '−' : '±')) . fmt_num(abs(round($d, 1))) . $unit;
    }
    if (!$was) return '';
    $d = round(($now - $was) / $was * 100);
    return ($d > 0 ? '+' : ($d < 0 ? '−' : '±')) . abs($d) . '%';
}

// colour of a change: up = good for every number in the report, except where it's neutral
function trend(?float $now, ?float $was): string
{
    if ($now === null || $was === null || !$was || abs($now - $was) / $was < 0.02) return 'flat';
    return $now > $was ? 'up' : 'down';
}

// the headline number of a set: est. 1RM, max reps for bodyweight, seconds for timed
function metric(array $s, array $i): float
{
    return $i['timed'] || $i['bw'] ? (float)$s['reps'] : brzycki($s['weight'], $s['reps']);
}

// "about 2 city buses" for a total load
function weight_of(float $kg): string
{
    foreach ([[150000, 'blue whale', 'blue whales'], [12000, 'city bus', 'city buses'], [6000, 'elephant', 'elephants'],
              [1500, 'car', 'cars'], [450, 'grand piano', 'grand pianos']] as [$w, $one, $many]) {
        if ($kg >= $w * 0.9) {
            $n = round($kg / $w);
            return $n <= 1 ? "about the weight of a $one" : "about the weight of $n $many";
        }
    }
    return '';
}

function plural(int $n, string $one, ?string $many = null): string
{
    return "$n " . ($n === 1 ? $one : ($many ?? $one . 's'));
}

$label = month_label($month);
$mName = month_name($month);
$pName = month_name($prev);
$firstMonth = !array_filter($ws, fn($w) => $w['date'] < "$month-01");

// PRs ranked by how much the headline number improved
$prList = [];
foreach ($prs as $ex => $pr) {
    $i = $infoOf($ex);
    $a = metric($pr['was'], $i);
    $b = metric($pr['now']['set'], $i);
    $prList[] = ['ex' => $ex, 'i' => $i, 'was' => $pr['was'], 'now' => $pr['now'], 'gain' => $a ? ($b - $a) / $a * 100 : 0];
}
usort($prList, fn($x, $y) => $y['gain'] <=> $x['gain']);
$prText = function (array $p): string {
    $txt = set_label($p['was'], $p['i']) . ' → ' . set_label($p['now']['set'], $p['i']);
    if (!$p['i']['timed'] && !$p['i']['bw']) {
        $txt .= sprintf(', est. 1RM %s → %s kg', fmt_num(round(brzycki($p['was']['weight'], $p['was']['reps']), 1)),
            fmt_num(round(brzycki($p['now']['set']['weight'], $p['now']['set']['reps']), 1)));
    }
    return $txt . ($p['gain'] > 0 ? sprintf(', +%d%%', round($p['gain'])) : '');
};

// working sets per week the program plans for each body part (one round of its days = one week)
$planSets = [];
if ($plan) foreach ($plan['days'] as $d) foreach ($d['items'] as $it) {
    $g = $infoOf($it['exercise'])['group'];
    $planSets[$g] = ($planSets[$g] ?? 0) + $it['sets'];
}

// ---------- what went well / what to improve: [title, explanation] ----------

$pct = fn($a, $b) => $b ? ($a - $b) / $b * 100 : null;
$good = $improve = [];
$weeks = $daysInMonth / 7;

if ($hasPrev) {
    $dl = $pct($cur['load'], $old['load']);
    if ($dl >= 5) {
        $good[] = [sprintf('Load up %d%%', round($dl)), sprintf('You moved %s against %s in %s. Total load (reps × weight over all your working sets) '
            . 'is the clearest sign you are doing more work over time, and doing more work over time is what makes muscles grow. '
            . 'Keep building it in small steps: an extra rep or an extra set before adding weight.', kg($cur['load']), kg($old['load']), $pName)];
    } elseif ($dl <= -5) {
        $improve[] = [sprintf('Load down %d%%', round(-$dl)), sprintf('You moved %s against %s in %s. A lighter month now and then is fine '
            . '(a deload, holidays, a cold), but if it wasn\'t planned, look at what changed: fewer sessions, fewer sets, or lighter weights. '
            . 'Next month, aim to at least match %s.', kg($cur['load']), kg($old['load']), $pName, kg($old['load'])), 'bringing your load back up'];
    }
    if ($cur['workouts'] > $old['workouts']) {
        $good[] = ['More sessions', sprintf('%s against %d in %s. How often you train is the foundation everything else rests on: '
            . 'this is the habit doing its job.', plural($cur['workouts'], 'workout'), $old['workouts'], $pName)];
    } elseif ($cur['workouts'] < $old['workouts'] && !$plan) {
        $improve[] = ['Fewer sessions', sprintf('%s against %d in %s. Pick fixed training days and treat them like appointments.',
            plural($cur['workouts'], 'workout'), $old['workouts'], $pName), 'training more often'];
    }
}

if ($plan && $cur['workouts']) {
    $planned = count($plan['days']);
    $expected = (int)round($planned * $weeks);
    if ($perWeek >= $planned - 0.25) {
        $good[] = ['Right on plan', sprintf('You averaged %.1f workouts a week, matching the %d days of "%s". Sticking to the plan is what lets '
            . 'progress build up: each session starts where the last one stopped.', $perWeek, $planned, $plan['name'])];
    } else {
        $improve[] = [sprintf('Consistency: %.1f of %d sessions a week', $perWeek, $planned), sprintf('"%s" plans %d workouts a week, about %d in %s, '
            . 'and you did %d. Missed sessions slow progress more than any choice of exercise or set scheme. Pick fixed days and treat them like '
            . 'appointments. On a busy day, a short session with only the first two exercises still counts and keeps the habit alive.',
            $plan['name'], $planned, $expected, $mName, $cur['workouts']), "getting all $planned sessions in every week"];
    }
    $missed = array_values(array_filter($plan['days'], fn($d) => !isset($doneDays[planName($plan, $d)])));
    if ($missed && count($missed) < $planned) {
        $improve[] = ['Skipped program days', implode(', ', array_map(fn($d) => $d['name'], $missed)) . (count($missed) > 1 ? ' were' : ' was')
            . sprintf(' never done this month. Each day trains different muscles, so skipping one leaves a gap. The program tab always marks '
            . 'the next day to do: following it rotates you through all %d.', $planned), 'rotating through every program day'];
    }
}

if ($prList) {
    $top = array_slice($prList, 0, 3);
    $good[] = [plural(count($prList), 'personal record'), (count($prList) > 3 ? 'Biggest jumps: ' : '')
        . implode('; ', array_map(fn($p) => "{$p['ex']} ({$prText($p)})", $top)) . '. '
        . 'A new record means your body adapted to the training you gave it: the plan is working for these lifts.'];
} elseif ($cur['workouts'] && !$firstMonth) {
    $improve[] = ['No personal records', 'None of your lifts beat their previous best this month. Try double progression: pick a rep range '
        . '(for example 8–12), and once you reach the top of it on every set, add 2.5 kg the next session and build the reps back up.', 'beating at least one record'];
}

if ($new) {
    $good[] = [count($new) > 8 ? plural(count($new), 'new exercise') : 'New exercises', ($firstMonth
        ? sprintf('This month set your starting point on %s. From now on each of them has a record to beat, so next month\'s report '
            . 'can show real progress and trends.', plural(count($new), 'exercise'))
        : 'You tried ' . implode(', ', $new) . '. New movements hit muscles from new angles; give them a few sessions before judging them.')];
}

$weak = array_values(array_filter(array_keys($cur['groups']), fn($g) => $g !== 'Other' && $cur['groups'][$g]['sets'] < LOW_SETS));
if ($cur['workouts'] && !$weak) {
    $good[] = ['Every body part trained', sprintf('All body parts got at least %d working sets. Balanced volume keeps your physique in proportion '
        . 'and lowers the risk of injury from one side being much stronger than the other.', LOW_SETS)];
}
if ($cur['workouts']) foreach ($weak as $g) {
    $n = $cur['groups'][$g]['sets'];
    $improve[] = ["$g: only " . plural($n, 'working set'), sprintf('That is about %s a week. To grow a muscle group, 10 to 20 hard sets a week '
        . 'is the usual target. ', fmt_num(round($n / $weeks, 1)) . ' set' . (round($n / $weeks, 1) == 1 ? '' : 's'))
        . (!empty($planSets[$g])
            ? sprintf('Your program plans %d sets a week for %s, so following it fully fixes this on its own.', $planSets[$g], strtolower($g))
            : 'Add two or three exercises for it to your week.'), 'giving ' . strtolower($g) . ' more work'];
}

if ($stalled) {
    $improve[] = [count($stalled) > 1 ? 'Stalled lifts' : 'A stalled lift', implode('; ', array_map(function ($ex, $s) use ($infoOf) {
        $i = $infoOf($ex);
        return sprintf('%s: best %s, the last %d sessions topped out at %s', $ex, set_label($s['best'], $i), STALL_SESSIONS, set_label($s['recent'], $i));
    }, array_keys($stalled), $stalled)) . '. When a lift stops moving, check sleep and food first. Then aim for one more rep before adding weight, '
        . 'take a lighter week (about 10% less), or swap to a close variation for 4 to 6 weeks.', 'getting ' . array_key_first($stalled) . ' moving again'];
}

if ($gap['days'] > 7) {
    $improve[] = [plural($gap['days'], 'day') . ' without training', sprintf('Between %s and %s. Breaks happen; what matters is restarting '
        . 'quickly. After more than a week off, go 5 to 10%% lighter for one session to ease back in.', $gap['from'], $gap['to']), 'keeping breaks short'];
}
if (!$cur['workouts']) {
    $improve[] = ['No workouts logged', 'Nothing was logged this month. Start small: one session this week, then build back up to your plan.', 'getting back into the gym'];
}

// ---------- motivation: an opener that fits the month, a fact, a closing line that changes every month ----------

$closers = [
    'Strength is built the way it is lost: one session at a time. Show up for the next one.',
    'Nobody sees the single great workout. They see the result of a hundred ordinary ones. Keep stacking them.',
    'Progress rarely feels like progress while it is happening. Read this report again in six months and you will see it.',
    'The bar does not care how motivated you feel. Turn up, do the work, and let the numbers move.',
    'Small wins compound: one more rep, 2.5 more kilos, one more session than last month.',
    'Discipline is choosing what you want most over what you want right now. This month, choose the gym.',
    'Your future self is built in the sessions you almost skipped.',
    'Every set you log is proof of the person you are becoming. Give yourself more proof this month.',
];
$closer = $closers[crc32($month) % count($closers)];

if (!$cur['workouts']) {
    $motivation = "$mName was a quiet month, and that is okay: every comeback starts with a single session. "
        . "Your records are still there, waiting to be beaten. $closer";
} else {
    $great = ($hasPrev && ($pct($cur['load'], $old['load']) ?? 0) >= 5) || count($prList) >= 3;
    $tough = $hasPrev && ($pct($cur['load'], $old['load']) ?? 0) <= -5;
    $opener = $firstMonth ? "$mName is where it all started: " . plural($cur['workouts'], 'workout') . ' logged and a starting point for every lift.'
        : ($great ? "$mName was a strong month, and the numbers prove it."
        : ($tough ? "$mName was a harder month, and that is part of the process too: no one progresses in a straight line."
        : "$mName was a steady month: you kept showing up."));
    $fact = sprintf('You moved %s in total, %s', tonnes($cur['load']), weight_of($cur['load']) ?: 'every kilo of it earned');
    $fact .= $prList ? sprintf(', and set %s, the biggest on %s.', plural(count($prList), 'personal record'), $prList[0]['ex']) : '.';
    $focus = $improve ? " For the month ahead, put your energy into {$improve[0][2]}." : '';
    $motivation = "$opener $fact$focus $closer";
}

// ---------- report ----------

$doc = [['header', $label]];
$doc[] = ['motivation', $motivation];

$kpi = fn($label, $value, $now, $was, $neutral = false) => [$label, $value,
    $hasPrev && $now !== null && $was !== null ? trim(delta($now, $was)) : '', $neutral ? 'flat' : trend($now, $was)];
$tiles = [
    $kpi('Workouts', $cur['workouts'], $cur['workouts'], $old['workouts']),
    $kpi('Active days', $cur['days'], $cur['days'], $old['days']),
    $kpi('Total load', tonnes($cur['load']), $cur['load'], $old['load']),
    $kpi('Working sets', $cur['sets'], $cur['sets'], $old['sets']),
    $kpi('Load / workout', $cur['workouts'] ? kg($cur['load'] / $cur['workouts']) : '—',
        $cur['workouts'] ? $cur['load'] / $cur['workouts'] : null, $old['workouts'] ? $old['load'] / $old['workouts'] : null),
    $kpi('Avg duration', $cur['avg_min'] ? round($cur['avg_min']) . ' min' : '—', $cur['avg_min'] ?: null, $old['avg_min'] ?: null, true),
];
if ($bwCur !== null) {
    $tiles[] = ['Body weight', fmt_num($bwCur) . ' kg', $bwOld !== null ? delta($bwCur, $bwOld, ' kg') : '', 'flat'];
}
$doc[] = ['h2', 'The month in numbers'];
$doc[] = ['kpis', $tiles, $hasPrev ? "vs $pName" : ''];

$groups = array_filter($cur['groups'], fn($g, $name) => $g['sets'] || $name !== 'Other', ARRAY_FILTER_USE_BOTH);
$maxSets = max(1, ...array_column($groups, 'sets'));
$doc[] = ['h2', 'Working sets per body part'];
$doc[] = ['bars', array_map(fn($name, $g) => [$name, $g['sets'] / $maxSets, $g['sets'] . ' sets · ' . kg($g['load'])
    . ($hasPrev && ($old['groups'][$name]['load'] ?? 0) ? ' (' . delta($g['load'], $old['groups'][$name]['load']) . ')' : ''),
    $g['sets'] < LOW_SETS && $name !== 'Other' ? 'warn' : 'normal'], array_keys($groups), $groups)];
$doc[] = ['small', sprintf('Under %d working sets in the month counts as low (red bars).', LOW_SETS)];

// month to month: the last 6 months that have data, up to this one
$trendRows = [];
for ($k = 5; $k >= 0; $k--) {
    $m = date('Y-m', strtotime("$month-01 -$k month"));
    $st = $m === $month ? $cur : month_stats($ws, $m, $infoOf, $groupNames);
    if ($st['workouts'] || $trendRows) $trendRows[] = [$m, $st];
}
$maxLoad = max(1, ...array_map(fn($r) => $r[1]['load'], $trendRows));
$doc[] = ['h2', 'Month to month'];
$doc[] = ['bars', array_map(fn($r) => [date('M Y', strtotime("{$r[0]}-15")), $r[1]['load'] / $maxLoad,
    tonnes($r[1]['load']) . ' · ' . plural($r[1]['workouts'], 'workout'), $r[0] === $month ? 'hi' : 'muted'], $trendRows)];
if (count($trendRows) === 1) $doc[] = ['small', 'The first month with data: next month this becomes a comparison.'];

$doc[] = ['h2', 'Personal records'];
if ($prList) {
    $doc[] = ['prs', array_map(fn($p) => [$p['ex'], set_label($p['was'], $p['i']), set_label($p['now']['set'], $p['i']),
        $p['gain'] > 0 ? sprintf('+%d%%', round($p['gain'])) : '', date('j M', strtotime($p['now']['date']))], $prList)];
    $doc[] = ['small', 'Change = estimated 1RM (Brzycki), or reps for bodyweight exercises.'];
} else {
    $doc[] = ['p', $firstMonth ? 'No records yet: this month is your starting point.' : 'No new personal records this month.'];
}

$doc[] = ['h2', 'What went well'];
$doc[] = $good ? ['insights', 'good', $good] : ['p', 'Nothing stood out this month.'];
$doc[] = ['h2', 'What to improve'];
$doc[] = $improve ? ['insights', 'improve', $improve] : ['p', 'Nothing to flag. Keep it up.'];
$doc[] = ['footer', 'Generated by fitness.simonsmind.com on ' . date('Y-m-d H:i') . '. The feedback follows fixed rules: '
    . sprintf('under %d working sets a month for a body part is low, %d sessions without beating your best is a stall, a break of more than 7 days is flagged.', LOW_SETS, STALL_SESSIONS)];

// ---------- output ----------

function md_bar(float $frac, int $width = 16): string
{
    $n = (int)round($frac * $width);
    return str_repeat('█', $n) . str_repeat('░', $width - $n);
}

function to_md(array $doc): string
{
    $cell = fn($v) => str_replace('|', '\|', (string)$v);
    $out = '';
    foreach ($doc as $b) {
        $out .= match ($b[0]) {
            'header' => "# Fitness report — {$b[1]}\n\n",
            'motivation' => "> {$b[1]}\n\n",
            'h2' => "## {$b[1]}\n\n",
            'p' => "{$b[1]}\n\n",
            'small' => "*{$b[1]}*\n\n",
            'footer' => "---\n*{$b[1]}*\n",
            'kpis' => "|  |  | {$b[2]} |\n|---|---|---|\n" . implode('', array_map(fn($k) => "| {$k[0]} | **{$k[1]}** | {$k[2]} |\n", $b[1])) . "\n",
            'bars' => "|  |  |  |\n|---|---|---|\n" . implode('', array_map(fn($r) => "| {$cell($r[0])} | `" . md_bar($r[1]) . "` | {$r[2]} |\n", $b[1])) . "\n",
            'prs' => "| Exercise | Before | New best | Change | Date |\n|---|---|---|---|---|\n"
                . implode('', array_map(fn($r) => '| ' . implode(' | ', array_map($cell, $r)) . " |\n", $b[1])) . "\n",
            'insights' => implode('', array_map(fn($x) => "- **{$x[0]}.** {$x[1]}\n", $b[2])) . "\n",
        };
    }
    return $out;
}

// email-safe HTML: inline styles and tables only (no SVG, no external CSS)
function to_html(array $doc): string
{
    $e = fn($v) => htmlspecialchars((string)$v, ENT_QUOTES);
    $c = ['bg' => '#eceff4', 'card' => '#ffffff', 'ink' => '#2e3440', 'muted' => '#6b778d', 'line' => '#e5e9f0', 'dark' => '#2e3440',
        'accent' => '#88c0d0', 'blue' => '#5e81ac', 'green' => '#3f8f4a', 'red' => '#bf616a', 'orange' => '#d08770', 'soft' => '#c9d4e3'];
    $trendColor = ['up' => $c['green'], 'down' => $c['red'], 'flat' => $c['muted']];
    $mono = "'JetBrains Mono',Menlo,Consolas,monospace";
    $bar = function (float $frac, string $color) use ($c) {
        $w = max(0, min(100, (int)round($frac * 100)));
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>'
            . ($w ? "<td width=\"$w%\" style=\"background:$color;height:12px;border-radius:6px;font-size:0;line-height:0\">&nbsp;</td>" : '')
            . ($w < 100 ? "<td style=\"background:{$c['line']};height:12px;border-radius:6px;font-size:0;line-height:0\">&nbsp;</td>" : '')
            . '</tr></table>';
    };
    $out = '';
    foreach ($doc as $b) {
        $out .= match ($b[0]) {
            'header' => "<tr><td style=\"background:{$c['dark']};padding:26px 28px 22px;border-radius:12px 12px 0 0\">"
                . "<div style=\"font-family:$mono;font-size:13px;color:{$c['accent']}\">~/SimonsMind/fitness<span style=\"color:#d8dee9\">_</span></div>"
                . "<div style=\"font-size:26px;font-weight:700;color:#eceff4;margin-top:10px\">{$e($b[1])}</div>"
                . "<div style=\"font-size:14px;color:#a9b6cc;margin-top:2px\">Monthly training report</div></td></tr>",
            'motivation' => "<tr><td style=\"padding:22px 28px 4px\"><div style=\"background:#f2f6fa;border-left:4px solid {$c['accent']};"
                . "border-radius:0 8px 8px 0;padding:14px 16px;font-size:15px;line-height:1.6;color:{$c['ink']}\">{$e($b[1])}</div></td></tr>",
            'h2' => "<tr><td style=\"padding:24px 28px 10px\"><div style=\"font-size:17px;font-weight:700;color:{$c['ink']}\">"
                . "<span style=\"color:{$c['accent']};font-family:$mono\">&gt;</span> {$e($b[1])}</div></td></tr>",
            'p' => "<tr><td style=\"padding:0 28px 6px;font-size:14px;color:{$c['ink']}\">{$e($b[1])}</td></tr>",
            'small' => "<tr><td style=\"padding:6px 28px 0;font-size:12px;color:{$c['muted']}\">{$e($b[1])}</td></tr>",
            'footer' => "<tr><td style=\"padding:28px 28px 26px;font-size:11px;line-height:1.5;color:{$c['muted']};border-top:1px solid {$c['line']}\">{$e($b[1])}</td></tr>",
            'kpis' => '<tr><td style="padding:0 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:6px">'
                . implode('', array_map(fn($row) => '<tr>' . implode('', array_map(fn($k) => "<td width=\"33%\" valign=\"top\" style=\"background:#f6f8fb;border:1px solid {$c['line']};border-radius:10px;padding:12px 12px 10px\">"
                    . "<div style=\"font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:{$c['muted']}\">{$e($k[0])}</div>"
                    . "<div style=\"font-size:20px;font-weight:700;color:{$c['ink']};margin-top:4px\">{$e($k[1])}</div>"
                    . "<div style=\"font-size:12px;font-weight:600;color:{$trendColor[$k[3]]};margin-top:2px;min-height:15px\">"
                    . ($k[2] !== '' ? ($k[3] === 'up' ? '▲ ' : ($k[3] === 'down' ? '▼ ' : '')) . $e($k[2]) . ($b[2] ? " <span style=\"font-weight:400;color:{$c['muted']}\">{$e($b[2])}</span>" : '') : '&nbsp;')
                    . '</div></td>', $row)) . str_repeat('<td width="33%"></td>', 3 - count($row)) . '</tr>', array_chunk($b[1], 3)))
                . '</table></td></tr>',
            'bars' => '<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">'
                . implode('', array_map(fn($r) => '<tr>'
                    . "<td width=\"78\" style=\"padding:6px 8px 6px 0;font-size:13px;color:{$c['ink']}\">{$e($r[0])}</td>"
                    . '<td style="padding:6px 0">' . $bar($r[1], ['normal' => $c['accent'], 'warn' => $c['red'], 'hi' => $c['blue'], 'muted' => $c['soft']][$r[3]]) . '</td>'
                    . "<td width=\"40%\" style=\"padding:6px 0 6px 10px;font-size:12px;line-height:1.35;color:{$c['muted']}\">{$e($r[2])}</td></tr>", $b[1]))
                . '</table></td></tr>',
            'prs' => '<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">'
                . "<tr>" . implode('', array_map(fn($h) => "<th align=\"left\" style=\"padding:6px 8px 6px 0;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:{$c['muted']};border-bottom:2px solid {$c['line']}\">$h</th>", ['Exercise', 'Before', 'New best', ''])) . '</tr>'
                . implode('', array_map(fn($r) => "<tr><td style=\"padding:8px 8px 8px 0;border-bottom:1px solid {$c['line']};color:{$c['ink']}\">🏆 {$e($r[0])}"
                    . "<div style=\"font-size:11px;color:{$c['muted']};margin-top:2px\">{$e($r[4])}</div></td>"
                    . "<td style=\"padding:8px 8px 8px 0;border-bottom:1px solid {$c['line']};color:{$c['muted']};white-space:nowrap\">{$e($r[1])}</td>"
                    . "<td style=\"padding:8px 8px 8px 0;border-bottom:1px solid {$c['line']};font-weight:700;white-space:nowrap\">{$e($r[2])}</td>"
                    . "<td style=\"padding:8px 0;border-bottom:1px solid {$c['line']};color:{$c['green']};font-weight:600;white-space:nowrap\">" . ($r[3] ? '▲ ' . $e($r[3]) : '') . '</td></tr>', $b[1]))
                . '</table></td></tr>',
            'insights' => '<tr><td style="padding:0 28px">' . implode('', array_map(fn($x) => sprintf(
                    '<div style="border-left:4px solid %s;background:%s;border-radius:0 8px 8px 0;padding:12px 14px;margin:0 0 10px">'
                    . '<div style="font-size:14px;font-weight:700;color:%s">%s %s</div>'
                    . '<div style="font-size:14px;line-height:1.55;color:%s;margin-top:4px">%s</div></div>',
                    $b[1] === 'good' ? $c['green'] : $c['orange'], $b[1] === 'good' ? '#f1f7f1' : '#fbf3ee',
                    $c['ink'], $b[1] === 'good' ? '✓' : '→', $e($x[0]), $c['ink'], $e($x[1])), $b[2])) . '</td></tr>',
        };
    }
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        . "<body style=\"margin:0;padding:0;background:{$c['bg']}\">"
        . "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:{$c['bg']}\"><tr><td align=\"center\" style=\"padding:24px 12px\">"
        . "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:640px;background:{$c['card']};border-radius:12px;"
        . "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:{$c['ink']}\">"
        . $out . '</table></td></tr></table></body></html>';
}

$md = to_md($doc);
echo in_array('--html', $args, true) ? to_html($doc) : $md;

if ($send) {
    if (!defined('REPORT_EMAIL')) {
        fwrite(STDERR, "REPORT_EMAIL is not defined in config.php\n");
        exit(1);
    }
    // the sender should be an address on your own domain, or mail gets flagged as spam
    $from = defined('REPORT_FROM') ? REPORT_FROM : REPORT_EMAIL;
    $boundary = 'b' . bin2hex(random_bytes(8));
    $headers = implode("\r\n", [
        'MIME-Version: 1.0',
        "From: Fitness <$from>",
        "Content-Type: multipart/alternative; boundary=\"$boundary\"",
    ]);
    $body = "--$boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($md))
        . "--$boundary\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode(to_html($doc)))
        . "--$boundary--\r\n";
    $subject = '=?UTF-8?B?' . base64_encode("Fitness report — $label") . '?=';
    if (!mail(REPORT_EMAIL, $subject, $body, $headers)) {
        fwrite(STDERR, "mail() failed\n");
        exit(1);
    }
    fwrite(STDERR, "sent to " . REPORT_EMAIL . "\n");
}
