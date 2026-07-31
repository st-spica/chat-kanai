<?php
/**
 * チャット API プロキシ（ブラウザ → 本ファイル → Vercel）
 * シークレットはサーバー側のみに置き、フロントの JS には出さない。
 */

declare(strict_types=1);

header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405);
  header('Content-Type: application/json; charset=UTF-8');
  echo json_encode(['answer' => 'Method not allowed', 'emergency' => false], JSON_UNESCAPED_UNICODE);
  exit;
}

$configPath = __DIR__ . '/api-proxy-config.php';
if (!is_readable($configPath)) {
  http_response_code(500);
  header('Content-Type: application/json; charset=UTF-8');
  echo json_encode([
    'answer' => 'APIプロキシの設定ファイルがありません。',
    'emergency' => false,
    'error' => 'Proxy config missing',
  ], JSON_UNESCAPED_UNICODE);
  exit;
}

/** @var array{upstream?:string,secret?:string} $config */
$config = require $configPath;
$upstream = trim((string) ($config['upstream'] ?? ''));
$secret = trim((string) ($config['secret'] ?? ''));

if ($upstream === '' || $secret === '') {
  http_response_code(500);
  header('Content-Type: application/json; charset=UTF-8');
  echo json_encode([
    'answer' => 'APIプロキシの設定が不完全です。',
    'emergency' => false,
    'error' => 'Proxy config incomplete',
  ], JSON_UNESCAPED_UNICODE);
  exit;
}

$rawBody = file_get_contents('php://input');
if ($rawBody === false || trim($rawBody) === '') {
  http_response_code(400);
  header('Content-Type: application/json; charset=UTF-8');
  echo json_encode(['answer' => 'メッセージが空です。', 'emergency' => false], JSON_UNESCAPED_UNICODE);
  exit;
}

if (!function_exists('curl_init')) {
  http_response_code(500);
  header('Content-Type: application/json; charset=UTF-8');
  echo json_encode([
    'answer' => 'サーバーで cURL が利用できません。',
    'emergency' => false,
    'error' => 'curl missing',
  ], JSON_UNESCAPED_UNICODE);
  exit;
}

$accept = isset($_SERVER['HTTP_ACCEPT'])
  ? (string) $_SERVER['HTTP_ACCEPT']
  : 'application/x-ndjson, application/json';

$clientIp = '';
if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
  $clientIp = trim(explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
} elseif (!empty($_SERVER['REMOTE_ADDR'])) {
  $clientIp = trim((string) $_SERVER['REMOTE_ADDR']);
}

$upstreamHeaders = [
  'Content-Type: application/json',
  'Accept: ' . $accept,
  'X-Chat-Secret: ' . $secret,
  // 上流が Origin を見る旧実装でも通るよう、公開サイトの Origin を明示
  'Origin: https://kanailc.xbiz.jp',
];
if ($clientIp !== '') {
  // Upstash のレート制限を「利用者ごと」に効かせる
  $upstreamHeaders[] = 'X-Forwarded-For: ' . $clientIp;
  $upstreamHeaders[] = 'X-Real-IP: ' . $clientIp;
}

$ch = curl_init($upstream);
if ($ch === false) {
  http_response_code(500);
  header('Content-Type: application/json; charset=UTF-8');
  echo json_encode(['answer' => '通信の準備に失敗しました。', 'emergency' => false], JSON_UNESCAPED_UNICODE);
  exit;
}

$responseHeaders = [];
$headersSent = false;

$sendResponseHeaders = static function () use (&$headersSent, &$responseHeaders, $ch): void {
  if ($headersSent) {
    return;
  }
  $headersSent = true;
  $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
  if ($status < 100) {
    $status = 502;
  }
  http_response_code($status);

  $contentType = $responseHeaders['content-type'] ?? 'application/json; charset=UTF-8';
  header('Content-Type: ' . $contentType);
  header('Cache-Control: no-cache, no-transform');
  if (isset($responseHeaders['x-accel-buffering'])) {
    header('X-Accel-Buffering: ' . $responseHeaders['x-accel-buffering']);
  }
};

curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => $rawBody,
  CURLOPT_HTTPHEADER => $upstreamHeaders,
  CURLOPT_RETURNTRANSFER => false,
  CURLOPT_HEADER => false,
  CURLOPT_FOLLOWLOCATION => false,
  CURLOPT_TIMEOUT => 120,
  CURLOPT_CONNECTTIMEOUT => 15,
  CURLOPT_HEADERFUNCTION => static function ($curl, string $headerLine) use (&$responseHeaders): int {
    $len = strlen($headerLine);
    $parts = explode(':', $headerLine, 2);
    if (count($parts) === 2) {
      $name = strtolower(trim($parts[0]));
      $value = trim($parts[1]);
      if ($name !== '') {
        $responseHeaders[$name] = $value;
      }
    }
    return $len;
  },
  CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use ($sendResponseHeaders): int {
    $sendResponseHeaders();
    echo $chunk;
    if (function_exists('ob_flush')) {
      @ob_flush();
    }
    @flush();
    return strlen($chunk);
  },
]);

if (function_exists('apache_setenv')) {
  @apache_setenv('no-gzip', '1');
}
@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');
while (ob_get_level() > 0) {
  @ob_end_flush();
}

$ok = curl_exec($ch);
$curlErr = curl_error($ch);

if ($ok === false) {
  if (!$headersSent) {
    http_response_code(502);
    header('Content-Type: application/json; charset=UTF-8');
    echo json_encode([
      'answer' => '上流APIへの接続に失敗しました。時間をおいて再度お試しください。',
      'emergency' => false,
      'error' => 'Upstream connection failed',
    ], JSON_UNESCAPED_UNICODE);
  }
  curl_close($ch);
  exit;
}

// ボディが空のエラー応答など
if (!$headersSent) {
  $sendResponseHeaders();
}

curl_close($ch);
