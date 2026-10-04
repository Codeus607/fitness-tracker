<?php
// JSON API for the fitness tracker. Data lives in DATA_DIR (outside the web root):
//   fitness.sqlite   the database (source of truth)
//   exercises.md     exercise list, pushed from the Obsidian vault
//   auth.json        password hash + failed-login log (created by setpass.php)
//   Fitness.md       human-readable backup, regenerated after every write
declare(strict_types=1);

require __DIR__ . '/config.php'; // defines DATA_DIR (and optionally TIMEZONE)
date_default_timezone_set(defined('TIMEZONE') ? TIMEZONE : 'UTC');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const COOKIE = 'fit_token';
const MAX_WEIGHT = 1000;
const MAX_REPS = 10000;

function out(array $data, int $code = 200): never
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $msg, int $code = 400): never
{
    out(['error' => $msg], $code);
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $pdo = new PDO('sqlite:' . DATA_DIR . '/fitness.sqlite');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec(<<<SQL
        CREATE TABLE IF NOT EXISTS workouts (
            id INTEGER PRIMARY KEY,
            date TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            note TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS sets (
            id INTEGER PRIMARY KEY,
            workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
            exercise TEXT NOT NULL,
            ex_order INTEGER NOT NULL,
            set_order INTEGER NOT NULL,
            reps REAL NOT NULL,
            weight REAL NOT NULL DEFAULT 0,
            warmup INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sets_workout ON sets(workout_id);
        CREATE TABLE IF NOT EXISTS goals (
            exercise TEXT PRIMARY KEY,
            target REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens (
            hash TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_used INTEGER NOT NULL
        );
    SQL);
    return $pdo;
}

// ---------- auth ----------

function authed(): bool
{
    $t = $_COOKIE[COOKIE] ?? '';
    if (!is_string($t) || strlen($t) !== 64) return false;
    $st = db()->prepare('UPDATE tokens SET last_used = ? WHERE hash = ?');
    $st->execute([time(), hash('sha256', $t)]);
    return $st->rowCount() > 0;
}

function set_cookie(string $value, int $expires): void
{
    setcookie(COOKIE, $value, [
        'expires' => $expires, 'path' => '/', 'secure' => true,
        'httponly' => true, 'samesite' => 'Strict',
    ]);
}

function login(string $pw): void
{
    $file = DATA_DIR . '/auth.json';
    if (!is_file($file)) fail('No password set on the server yet (run setpass.php)', 503);
    $fh = fopen($file, 'c+');
    flock($fh, LOCK_EX);
    $auth = json_decode(stream_get_contents($fh), true) ?: [];
    $now = time();
    $fails = array_values(array_filter($auth['fails'] ?? [], fn($t) => $t > $now - 900));
    $ok = count($fails) < 5 && password_verify($pw, $auth['hash'] ?? '');
    if (!$ok && count($fails) < 5) $fails[] = $now;
    $auth['fails'] = $ok ? [] : $fails;
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($auth));
    fclose($fh);
    if (count($fails) >= 5 && !$ok) fail('Too many attempts, try again in 15 minutes', 429);
    if (!$ok) {
        usleep(400000);
        fail('Wrong password', 401);
    }
    $token = bin2hex(random_bytes(32));
    db()->prepare('INSERT INTO tokens (hash, created_at, last_used) VALUES (?, ?, ?)')
        ->execute([hash('sha256', $token), $now, $now]);
    set_cookie($token, $now + 365 * 86400);
}

// ---------- exercises.md ----------

// "## Group" headings, "- Name (bw)" / "- Name (sec, bw)" items.
function exercises(): array
{
    $groups = [];
    $cur = null;
    foreach (@file(DATA_DIR . '/exercises.md', FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        if (preg_match('/^##\s+(.+?)\s*$/', $line, $m)) {
            $cur = count($groups);
            $groups[] = ['name' => $m[1], 'exercises' => []];
        } elseif ($cur !== null && preg_match('/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/', $line, $m)) {
            $name = $m[1];
            $tags = [];
            if (preg_match('/\s*\(\s*((?:sec|bw)(?:\s*,\s*(?:sec|bw))*)\s*\)$/i', $name, $t)) {
                $tags = array_map('trim', explode(',', strtolower($t[1])));
                $name = substr($name, 0, -strlen($t[0]));
            }
            $groups[$cur]['exercises'][] = [
                'name' => $name,
                'timed' => in_array('sec', $tags, true),
                'bw' => in_array('bw', $tags, true),
            ];
        }
    }
    return $groups;
}

// ---------- data ----------

function workouts(?int $id = null): array
{
    $sql = 'SELECT * FROM workouts' . ($id ? ' WHERE id = ?' : '') . ' ORDER BY date, started_at';
    $st = db()->prepare($sql);
    $st->execute($id ? [$id] : []);
    $ws = [];
    foreach ($st as $w) {
        $w['sets'] = [];
        $ws[$w['id']] = $w;
    }
    if (!$ws) return [];
    $ids = implode(',', array_keys($ws));
    foreach (db()->query("SELECT * FROM sets WHERE workout_id IN ($ids) ORDER BY ex_order, set_order, id") as $s) {
        $ws[$s['workout_id']]['sets'][] = $s;
    }
    return array_values($ws);
}

function workout(int $id): array
{
    return workouts($id)[0] ?? fail('Workout not found', 404);
}

function num($v, float $min, float $max, string $what): float
{
    if (!is_numeric($v) || $v < $min || $v > $max) fail("Invalid $what");
    return round((float)$v, 2);
}

function valid_date($d): string
{
    if (!is_string($d) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) || !strtotime($d)) fail('Invalid date');
    return $d;
}

// ---------- Fitness.md backup ----------

function fmt_num(float $n): string
{
    return rtrim(rtrim(number_format($n, 2, '.', ''), '0'), '.');
}

function brzycki(float $w, float $r): float
{
    if ($r <= 0) return 0;
    if ($r == 1) return $w;
    return $r < 37 ? $w * 36 / (37 - $r) : $w;
}

function set_label(array $s, array $info): string
{
    $w = (float)$s['weight'];
    $r = fmt_num((float)$s['reps']);
    $prefix = $s['warmup'] ? 'W ' : '';
    if ($info['timed']) return $prefix . ($w > 0 ? '+' . fmt_num($w) . 'kg ' : '') . $r . 's';
    if ($info['bw']) return $prefix . ($w > 0 ? '+' . fmt_num($w) : 'BW') . '×' . $r;
    return $prefix . fmt_num($w) . '×' . $r;
}

function write_md(): void
{
    $info = [];
    $order = [];
    foreach (exercises() as $g) {
        foreach ($g['exercises'] as $e) {
            $info[$e['name']] = $e + ['group' => $g['name']];
            $order[$e['name']] = count($order);
        }
    }
    $infoOf = fn($name) => $info[$name] ?? ['name' => $name, 'group' => 'Other', 'timed' => false, 'bw' => false];
    $ws = workouts();

    // best set per exercise: timed by seconds, bodyweight by extra weight then reps, otherwise by Brzycki 1RM
    $best = [];
    foreach ($ws as $w) {
        foreach ($w['sets'] as $s) {
            if ($s['warmup']) continue;
            $i = $infoOf($s['exercise']);
            $score = $i['timed'] ? [$s['reps'], $s['weight']]
                : ($i['bw'] ? [$s['weight'], $s['reps']] : [brzycki($s['weight'], $s['reps']), $s['weight'], $s['reps']]);
            $b = &$best[$s['exercise']];
            if (!$b || $score > $b['score']) $b = ['score' => $score, 'set' => $s, 'date' => $w['date'], 'last' => $w['date']];
            $b['last'] = max($b['last'], $w['date']);
            unset($b);
        }
    }
    uksort($best, fn($a, $b) => ($order[$a] ?? PHP_INT_MAX) <=> ($order[$b] ?? PHP_INT_MAX) ?: strcmp($a, $b));

    $md = "# Fitness\n\n";
    $md .= "> Backup generated by fitness.simonsmind.com on " . date('Y-m-d H:i') . ". Do not edit: it is overwritten on every save.\n\n";
    $md .= "## Best lifts\n\n| Body part | Exercise | Best set | Est. 1RM | Set on | Last done |\n|---|---|---|---|---|---|\n";
    foreach ($best as $name => $b) {
        $i = $infoOf($name);
        $e1rm = $i['timed'] || $i['bw'] || !$b['set']['weight'] ? '' : fmt_num(round(brzycki($b['set']['weight'], $b['set']['reps']), 1)) . ' kg';
        $md .= "| {$i['group']} | " . str_replace('|', '\|', $name) . ' | ' . set_label($b['set'], $i) . " | $e1rm | {$b['date']} | {$b['last']} |\n";
    }

    $md .= "\n## Workouts\n";
    foreach (array_reverse($ws) as $w) {
        $byEx = [];
        foreach ($w['sets'] as $s) $byEx[$s['exercise']][] = $s;
        $groups = array_unique(array_map(fn($n) => $infoOf($n)['group'], array_keys($byEx)));
        $md .= "\n### {$w['date']}" . ($groups ? ' — ' . implode(', ', $groups) : '') . "\n\n";
        $total = 0;
        $nsets = 0;
        $rows = '';
        foreach ($byEx as $name => $sets) {
            $i = $infoOf($name);
            $load = 0;
            foreach ($sets as $s) {
                if ($s['warmup']) continue;
                $nsets++;
                if (!$i['timed']) $load += $s['reps'] * $s['weight'];
            }
            $total += $load;
            $rows .= '| ' . str_replace('|', '\|', $name) . ' | ' . implode(', ', array_map(fn($s) => set_label($s, $i), $sets))
                . ' | ' . ($load ? fmt_num($load) . ' kg' : '') . " |\n";
        }
        $meta = ["$nsets sets", 'load ' . number_format($total, 0, '.', ' ') . ' kg'];
        if ($w['finished_at'] && $w['finished_at'] - $w['started_at'] < 6 * 3600) {
            $meta[] = round(($w['finished_at'] - $w['started_at']) / 60) . ' min';
        }
        if (!$w['finished_at']) $meta[] = 'in progress';
        $md .= '*' . implode(' · ', $meta) . "*\n";
        if (trim($w['note']) !== '') $md .= "\n> " . str_replace("\n", "\n> ", trim($w['note'])) . "\n";
        if ($rows) $md .= "\n| Exercise | Sets (kg × reps) | Load |\n|---|---|---|\n" . $rows;
    }

    $tmp = DATA_DIR . '/Fitness.md.tmp';
    file_put_contents($tmp, $md);
    rename($tmp, DATA_DIR . '/Fitness.md');
}

// ---------- routing ----------

$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$in = [];
if ($method === 'POST') {
    // custom header + SameSite=Strict cookie = no cross-site requests
    if (($_SERVER['HTTP_X_FIT'] ?? '') !== '1') fail('Bad request', 400);
    $in = json_decode(file_get_contents('php://input') ?: '[]', true);
    if (!is_array($in)) fail('Bad JSON');
}

if ($action === 'login' && $method === 'POST') {
    login((string)($in['password'] ?? ''));
    out(['ok' => true]);
}
if (!authed()) fail('Not logged in', 401);

$changed = false;
$result = match ("$method $action") {
    'GET data' => [
        'exercises' => exercises(),
        'workouts' => workouts(),
        'goals' => (object)array_column(db()->query('SELECT exercise, target FROM goals')->fetchAll(), 'target', 'exercise'),
    ],

    'POST logout' => (function () {
        db()->prepare('DELETE FROM tokens WHERE hash = ?')->execute([hash('sha256', $_COOKIE[COOKIE])]);
        set_cookie('', 1);
        return ['ok' => true];
    })(),

    'POST workout_start' => (function () use ($in, &$changed) {
        $open = db()->query('SELECT id FROM workouts WHERE finished_at IS NULL')->fetchColumn();
        if ($open) fail('A workout is already in progress');
        db()->prepare('INSERT INTO workouts (date, started_at) VALUES (?, ?)')
            ->execute([valid_date($in['date'] ?? ''), time()]);
        $changed = true;
        return ['workout' => workout((int)db()->lastInsertId())];
    })(),

    'POST workout_update' => (function () use ($in, &$changed) {
        $w = workout((int)($in['id'] ?? 0));
        $date = isset($in['date']) ? valid_date($in['date']) : $w['date'];
        $note = isset($in['note']) ? mb_substr((string)$in['note'], 0, 2000) : $w['note'];
        $finished = $w['finished_at'];
        if (array_key_exists('finished', $in)) {
            if (!$in['finished'] && db()->query('SELECT COUNT(*) FROM workouts WHERE finished_at IS NULL')->fetchColumn()) {
                fail('Finish the workout in progress first');
            }
            $finished = $in['finished'] ? ($w['finished_at'] ?: time()) : null;
        }
        db()->prepare('UPDATE workouts SET date = ?, note = ?, finished_at = ? WHERE id = ?')
            ->execute([$date, $note, $finished, $w['id']]);
        $changed = true;
        return ['workout' => workout($w['id'])];
    })(),

    'POST workout_delete' => (function () use ($in, &$changed) {
        db()->prepare('DELETE FROM workouts WHERE id = ?')->execute([(int)($in['id'] ?? 0)]);
        $changed = true;
        return ['ok' => true];
    })(),

    'POST set_save' => (function () use ($in, &$changed) {
        $w = workout((int)($in['workout_id'] ?? 0));
        $ex = trim((string)($in['exercise'] ?? ''));
        if ($ex === '' || mb_strlen($ex) > 120) fail('Invalid exercise');
        $vals = [
            $ex,
            (int)num($in['ex_order'] ?? 0, 0, 1000, 'order'),
            (int)num($in['set_order'] ?? 0, 0, 1000, 'order'),
            num($in['reps'] ?? null, 0.01, MAX_REPS, 'reps'),
            num($in['weight'] ?? 0, 0, MAX_WEIGHT, 'weight'),
            empty($in['warmup']) ? 0 : 1,
        ];
        if (!empty($in['id'])) {
            $st = db()->prepare('UPDATE sets SET exercise = ?, ex_order = ?, set_order = ?, reps = ?, weight = ?, warmup = ?
                                 WHERE id = ? AND workout_id = ?');
            $st->execute([...$vals, (int)$in['id'], $w['id']]);
            if (!$st->rowCount()) fail('Set not found', 404);
            $id = (int)$in['id'];
        } else {
            db()->prepare('INSERT INTO sets (exercise, ex_order, set_order, reps, weight, warmup, workout_id, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)')->execute([...$vals, $w['id'], time()]);
            $id = (int)db()->lastInsertId();
        }
        $changed = true;
        return ['id' => $id, 'workout' => workout($w['id'])];
    })(),

    'POST set_delete' => (function () use ($in, &$changed) {
        $ids = array_map('intval', (array)($in['ids'] ?? []));
        $w = workout((int)($in['workout_id'] ?? 0));
        if ($ids) {
            $marks = implode(',', array_fill(0, count($ids), '?'));
            db()->prepare("DELETE FROM sets WHERE workout_id = ? AND id IN ($marks)")->execute([$w['id'], ...$ids]);
        }
        $changed = true;
        return ['workout' => workout($w['id'])];
    })(),

    'POST goal_set' => (function () use ($in, &$changed) {
        $ex = trim((string)($in['exercise'] ?? ''));
        if ($ex === '') fail('Invalid exercise');
        if (empty($in['target'])) {
            db()->prepare('DELETE FROM goals WHERE exercise = ?')->execute([$ex]);
        } else {
            db()->prepare('INSERT INTO goals (exercise, target) VALUES (?, ?) ON CONFLICT(exercise) DO UPDATE SET target = excluded.target')
                ->execute([$ex, num($in['target'], 0.01, MAX_REPS, 'target')]);
        }
        return ['ok' => true];
    })(),

    default => fail('Unknown action', 404),
};

if ($changed) write_md();
out($result);
