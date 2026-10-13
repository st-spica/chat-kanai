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
  'Origin: https://kanai.or.jp',
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
  // Vercel の診断ヘッダをブラウザまで透過（患者UIは使わない）
  foreach (['x-chat-request-id', 'x-chat-error-code', 'x-chat-error-stage', 'x-chat-stream-phase'] as $hName) {
    if (isset($responseHeaders[$hName]) && $responseHeaders[$hName] !== '') {
      header($hName . ': ' . $responseHeaders[$hName]);
    }
  }
};

// Vercel maxDuration=60s より先に PHP が切れないよう、cURL は 55s に合わせる。
// （旧 120s だと Vercel 切断後も PHP が待ち続け、途中切断・空応答の原因になる）
@ini_set('max_execution_time', '70');
@set_time_limit(70);

curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => $rawBody,
  CURLOPT_HTTPHEADER => $upstreamHeaders,
  CURLOPT_RETURNTRANSFER => false,
  CURLOPT_HEADER => false,
  CURLOPT_FOLLOWLOCATION => false,
  CURLOPT_TIMEOUT => 55,
  CURLOPT_CONNECTTIMEOUT => 10,
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
  $errno = curl_errno($ch);
  error_log(sprintf(
    '[api-proxy] curl_failed errno=%d err=%s headersSent=%s',
    $errno,
    $curlErr,
    $headersSent ? '1' : '0'
  ));
  if (!$headersSent) {
    http_response_code(502);
    header('Content-Type: application/json; charset=UTF-8');
    // 患者向けは内部詳細を出さない
    echo json_encode([
      'answer' => '申し訳ありません。一時的に回答できませんでした。少し時間をおいて、もう一度お試しください。',
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
