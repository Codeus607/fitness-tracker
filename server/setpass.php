<?php
// Set the app password. Run through setpass.sh, which reads it without echoing
// (Hostinger disables system(), so PHP can't toggle the terminal itself).
// Also logs out every device (clears all login tokens).
declare(strict_types=1);

$dir = __DIR__;
$pw = rtrim((string)fgets(STDIN), "\r\n");
$again = rtrim((string)fgets(STDIN), "\r\n");

if ($pw !== $again) exit("Passwords don't match.\n");
if (strlen($pw) < 8) exit("Use at least 8 characters.\n");

// changed_at lets other apps sharing this password (e.g. the meditation app) drop older logins
file_put_contents("$dir/auth.json", json_encode(['hash' => password_hash($pw, PASSWORD_DEFAULT), 'fails' => [], 'changed_at' => time()]));
chmod("$dir/auth.json", 0600);
if (is_file("$dir/fitness.sqlite")) {
    $db = new PDO("sqlite:$dir/fitness.sqlite");
    try { $db->exec('DELETE FROM tokens'); } catch (PDOException) {}
}
echo "Password set. All devices logged out.\n";
