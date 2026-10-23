<?php
// Monthly report, run from the command line (not reachable over the web, see .htaccess):
//   php report.php [YYYY-MM] [--send]
// Prints the report of that month (default: last month) as markdown.
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
    if (!array_filter($recent, fn($x) => score($x['best'], $i) > score($best, $i))) $stalled[] = $ex;
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

// ---------- what went well / what to improve ----------

$pct = fn($a, $b) => $b ? ($a - $b) / $b * 100 : null;
$good = $improve = [];

if ($hasPrev) {
    $dl = $pct($cur['load'], $old['load']);
    if ($dl >= 5) $good[] = sprintf('Total load went up %d%% compared to %s.', round($dl), month_label($prev));
    elseif ($dl <= -5) $improve[] = sprintf('Total load dropped %d%% compared to %s.', round(-$dl), month_label($prev));
    if ($cur['workouts'] > $old['workouts']) $good[] = "You trained more often: {$cur['workouts']} workouts against {$old['workouts']}.";
    elseif ($cur['workouts'] < $old['workouts']) $improve[] = "Fewer workouts than last month: {$cur['workouts']} against {$old['workouts']}.";
}
if ($plan) {
    $planned = count($plan['days']);
    $line = sprintf('%.1f workouts a week on average, for %d planned in "%s".', $perWeek, $planned, $plan['name']);
    if ($perWeek >= $planned - 0.25) $good[] = "Consistent: $line";
    else $improve[] = "Consistency: $line";
    $missed = array_values(array_filter($plan['days'], fn($d) => !isset($doneDays[planName($plan, $d)])));
    if ($missed && count($missed) < $planned) {
        $improve[] = 'Program days never done this month: ' . implode(', ', array_map(fn($d) => $d['name'], $missed)) . '.';
    }
}
if ($prs) $good[] = count($prs) . ' personal record' . (count($prs) > 1 ? 's' : '') . ': ' . implode(', ', array_keys($prs)) . '.';
elseif ($cur['workouts']) $improve[] = 'No personal records this month.';
if ($new) $good[] = count($new) > 8 ? count($new) . ' exercises logged for the first time.' : 'New exercises tried: ' . implode(', ', $new) . '.';
$weak = array_keys(array_filter($cur['groups'], fn($g) => $g['sets'] < LOW_SETS));
$weak = array_values(array_filter($weak, fn($g) => $g !== 'Other'));
if ($cur['workouts'] && $weak) {
    $improve[] = 'Little volume for ' . implode(', ', array_map(fn($g) => "$g ({$cur['groups'][$g]['sets']} sets)", $weak))
        . sprintf(', under %d working sets in the month.', LOW_SETS);
} elseif ($cur['workouts']) {
    $good[] = sprintf('Every body part got at least %d working sets.', LOW_SETS);
}
if ($stalled) $improve[] = sprintf('No progress in the last %d sessions: ', STALL_SESSIONS) . implode(', ', $stalled) . '. Try adding a rep or 2.5 kg, or swap the variation.';
if ($gap['days'] > 7) $improve[] = "Longest break: {$gap['days']} days ({$gap['from']} → {$gap['to']}).";
if (!$cur['workouts']) $improve[] = 'No workouts logged this month.';

// ---------- report ----------

function month_label(string $m): string
{
    return date('F Y', strtotime("$m-15"));
}

function planName(array $p, array $d): string
{
    return "{$p['name']} / {$d['name']}";
}

function kg(float $n): string
{
    return number_format($n, 0, '.', ' ') . ' kg';
}

// change between two numbers: "+12%" (or "+0.4 kg" for small absolute values)
function delta(?float $now, ?float $was, string $unit = '%'): string
{
    if ($now === null || $was === null) return '—';
    if ($unit !== '%') {
        $d = $now - $was;
        return ($d > 0 ? '+' : ($d < 0 ? '−' : '±')) . fmt_num(abs(round($d, 1))) . $unit;
    }
    if (!$was) return '—';
    $d = round(($now - $was) / $was * 100);
    return ($d > 0 ? '+' : ($d < 0 ? '−' : '±')) . abs($d) . '%';
}

$label = month_label($month);
$doc = [['h1', "Fitness report — $label"]];

$rows = [
    ['Workouts', $cur['workouts'], $hasPrev ? $old['workouts'] : '—', $hasPrev ? delta($cur['workouts'], $old['workouts']) : '—'],
    ['Active days', $cur['days'], $hasPrev ? $old['days'] : '—', $hasPrev ? delta($cur['days'], $old['days']) : '—'],
    ['Total load', kg($cur['load']), $hasPrev ? kg($old['load']) : '—', $hasPrev ? delta($cur['load'], $old['load']) : '—'],
    ['Working sets', $cur['sets'], $hasPrev ? $old['sets'] : '—', $hasPrev ? delta($cur['sets'], $old['sets']) : '—'],
    ['Load per workout', $cur['workouts'] ? kg($cur['load'] / $cur['workouts']) : '—', $hasPrev ? kg($old['load'] / $old['workouts']) : '—',
        $hasPrev && $cur['workouts'] ? delta($cur['load'] / $cur['workouts'], $old['load'] / $old['workouts']) : '—'],
    ['Average duration', $cur['avg_min'] ? round($cur['avg_min']) . ' min' : '—', $hasPrev && $old['avg_min'] ? round($old['avg_min']) . ' min' : '—',
        $hasPrev && $cur['avg_min'] && $old['avg_min'] ? delta($cur['avg_min'], $old['avg_min']) : '—'],
];
if ($bwCur !== null || $bwOld !== null) {
    $rows[] = ['Body weight (end of month)', $bwCur !== null ? fmt_num($bwCur) . ' kg' : '—', $bwOld !== null ? fmt_num($bwOld) . ' kg' : '—', delta($bwCur, $bwOld, ' kg')];
}
$doc[] = ['h2', 'Summary'];
$doc[] = ['table', ['', month_label($month), month_label($prev), 'Change'], $rows];

$doc[] = ['h2', 'Load per body part'];
$doc[] = ['table', ['Body part', 'Working sets', 'Load', 'Load vs ' . date('M', strtotime("$prev-15"))], array_map(
    fn($g) => [$g, $cur['groups'][$g]['sets'], kg($cur['groups'][$g]['load']),
        $hasPrev ? delta($cur['groups'][$g]['load'], $old['groups'][$g]['load'] ?? 0) : '—'],
    array_keys(array_filter($cur['groups'], fn($g, $name) => $g['sets'] || $name !== 'Other', ARRAY_FILTER_USE_BOTH))
)];

// month to month: the last 6 months that have data, up to this one
$trend = [];
for ($k = 5; $k >= 0; $k--) {
    $m = date('Y-m', strtotime("$month-01 -$k month"));
    $st = $m === $month ? $cur : month_stats($ws, $m, $infoOf, $groupNames);
    if ($st['workouts'] || $trend) $trend[] = [month_label($m), $st['workouts'], $st['sets'], kg($st['load'])];
}
$doc[] = ['h2', 'Month to month'];
$doc[] = ['table', ['Month', 'Workouts', 'Working sets', 'Total load'], $trend];

$doc[] = ['h2', 'Personal records'];
if ($prs) {
    $doc[] = ['table', ['Exercise', 'New best', 'Starting best', 'Date'], array_map(function ($ex, $pr) use ($infoOf) {
        $i = $infoOf($ex);
        $e1 = fn($s) => $i['timed'] || $i['bw'] ? '' : ' (1RM ' . fmt_num(round(brzycki($s['weight'], $s['reps']), 1)) . ')';
        return [$ex, set_label($pr['now']['set'], $i) . $e1($pr['now']['set']), set_label($pr['was'], $i) . $e1($pr['was']), $pr['now']['date']];
    }, array_keys($prs), $prs)];
} else {
    $doc[] = ['p', 'No new personal records this month.'];
}
if ($new && count($new) <= 8) $doc[] = ['p', 'First time logged (no record to beat yet): ' . implode(', ', $new) . '.'];

$doc[] = ['h2', 'What went well'];
$doc[] = $good ? ['ul', $good] : ['p', 'Nothing stood out this month.'];
$doc[] = ['h2', 'What to improve'];
$doc[] = $improve ? ['ul', $improve] : ['p', 'Nothing to flag. Keep it up.'];
$doc[] = ['small', 'Generated by fitness.simonsmind.com on ' . date('Y-m-d H:i') . '. The advice follows fixed rules: '
    . sprintf('under %d working sets a month per body part is low, %d sessions without a better best set is a stall, a break of more than 7 days is flagged.', LOW_SETS, STALL_SESSIONS)];

// ---------- output ----------

function to_md(array $doc): string
{
    $cell = fn($v) => str_replace('|', '\|', (string)$v);
    $out = '';
    foreach ($doc as $b) {
        $out .= match ($b[0]) {
            'h1' => "# {$b[1]}\n\n",
            'h2' => "## {$b[1]}\n\n",
            'p' => "{$b[1]}\n\n",
            'small' => "> {$b[1]}\n",
            'ul' => implode('', array_map(fn($x) => "- $x\n", $b[1])) . "\n",
            'table' => '| ' . implode(' | ', array_map($cell, $b[1])) . " |\n|" . str_repeat('---|', count($b[1])) . "\n"
                . implode('', array_map(fn($r) => '| ' . implode(' | ', array_map($cell, $r)) . " |\n", $b[2])) . "\n",
        };
    }
    return $out;
}

function to_html(array $doc): string
{
    $e = fn($v) => htmlspecialchars((string)$v, ENT_QUOTES);
    $td = 'padding:6px 10px;border-bottom:1px solid #d8dee9;text-align:left';
    $out = '';
    foreach ($doc as $b) {
        $out .= match ($b[0]) {
            'h1' => "<h1 style=\"font-size:22px;color:#2e3440;margin:0 0 16px\">{$e($b[1])}</h1>",
            'h2' => "<h2 style=\"font-size:16px;color:#5e81ac;margin:24px 0 8px\">{$e($b[1])}</h2>",
            'p' => "<p style=\"margin:0 0 10px\">{$e($b[1])}</p>",
            'small' => "<p style=\"margin:28px 0 0;color:#7b88a1;font-size:12px\">{$e($b[1])}</p>",
            'ul' => '<ul style="margin:0 0 10px;padding-left:20px">' . implode('', array_map(fn($x) => "<li style=\"margin:4px 0\">{$e($x)}</li>", $b[1])) . '</ul>',
            'table' => '<table style="border-collapse:collapse;width:100%;font-size:14px"><tr>'
                . implode('', array_map(fn($h) => "<th style=\"$td;color:#4c566a;font-weight:600\">{$e($h)}</th>", $b[1])) . '</tr>'
                . implode('', array_map(fn($r) => '<tr>' . implode('', array_map(fn($c) => "<td style=\"$td\">{$e($c)}</td>", $r)) . '</tr>', $b[2]))
                . '</table>',
        };
    }
    return '<!doctype html><html><body style="margin:0;padding:24px;background:#eceff4">'
        . '<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#2e3440;line-height:1.45">'
        . $out . '</div></body></html>';
}

$md = to_md($doc);
echo $md;

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
