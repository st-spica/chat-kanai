<?php
/**
 * AIお悩み相談
 * 同サーバー WordPress のヘッダー／フッターのみを利用する。
 * 配置想定: WP ルート直下の consul_ai/index.php
 */

$wp_load_candidates = [
  dirname(__DIR__) . '/wp-load.php',
  isset($_SERVER['DOCUMENT_ROOT'])
    ? rtrim((string) $_SERVER['DOCUMENT_ROOT'], "/\\") . '/wp-load.php'
    : '',
];

$wp_loaded = false;
foreach ($wp_load_candidates as $candidate) {
  if ($candidate !== '' && is_readable($candidate)) {
    require_once $candidate;
    $wp_loaded = true;
    break;
  }
}

if (!$wp_loaded) {
  http_response_code(500);
  header('Content-Type: text/plain; charset=UTF-8');
  echo "読み込めませんでした。";
  exit;
}

$consul_ai_base = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? ''))), '/');
if ($consul_ai_base === '' || $consul_ai_base === '.') {
  $consul_ai_base = '/consul_ai';
}

add_filter(
  'pre_get_document_title',
  static function () {
    return 'ご質問・ご意見 AIチャットサポート';
  },
  20
);

add_action(
  'wp_head',
  static function () use ($consul_ai_base) {
    echo '<meta name="robots" content="noindex,nofollow">' . "\n";
    echo '<meta name="referrer" content="no-referrer">' . "\n";
    echo '<link rel="stylesheet" href="' . esc_url($consul_ai_base . '/assets/css/style.css') . '">' . "\n";
  },
  20
);

status_header(200);
nocache_headers();
get_header();
?>

<main class="consul-ai" id="consul-ai">

<div id="chatUI">

  <div class="box" style="margin-bottom:12px;">
    <pre class="muted" id="disclaimerFixed"></pre>
    <ul class="attention">
      <li>AIによる自動回答のため内容に誤りがある可能性もございます。重要な事柄については、お電話にてスタッフまでご確認ください。</li>
      <li>緊急時や、個別の症状に関するご相談は直接お電話ください。</li>
      <li>安心してご利用いただくために、お名前やご住所、電話番号などの個人情報の入力はお控えください。</li>
    </ul>
  </div>

  <div class="box msgs" id="msgs"></div>

  <div class="row">
    <input
      id="input"
      maxlength="500"
      placeholder="お悩みをお聞かせください。（個人情報は入力しないでください）"
    />
    <button id="sendBtn">送信</button>
  </div>

  <div class="home_btn"><a href="<?php echo home_url(); ?>"><img src="<?php echo get_template_directory_uri(); ?>/assets/images/icon/home.svg">ホームに戻る</a></div>
  
</div>

  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.7/dist/purify.min.js"></script>
  <script src="<?php echo esc_url($consul_ai_base . '/assets/js/chat.js'); ?>"></script>
</main>

<?php
get_footer();
