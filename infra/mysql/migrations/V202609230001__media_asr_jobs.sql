-- 媒体自动语音识别（ASR）任务表：制课工作台的「自动切分」模块把音频交给本地
-- whisper.cpp 识别，结果（分段 JSON + 可直接导入的 SRT 文本）缓存在这里。
-- 同一个媒体对象（同一 bucket + object key + 内容 ETag）+ 同一模型/语言只识别一次，
-- 之后再次发起会直接命中缓存返回，不再重复占用 CPU。
create table if not exists media_asr_jobs (
  id bigint unsigned primary key auto_increment,
  -- 缓存键的媒体部分：对象键在上传时带时间戳与随机 id，天然不会原地变化；
  -- 仍保留 etag/size 用于校验（例如人工替换过同名对象或从 CDN 迁移后重跑）。
  bucket varchar(191) not null,
  object_name varchar(512) not null,
  media_etag varchar(128) null,
  media_size_bytes bigint null,
  -- 识别参数：缓存键的参数部分。模型名取自 whisper 模型文件名，language 为 whisper 语言代码或 auto。
  model_name varchar(191) not null,
  language varchar(16) not null default 'auto',
  -- pending：已入库等待本地识别进程；running：识别中；succeeded/failed：终态。
  status enum('pending', 'running', 'succeeded', 'failed') not null default 'pending',
  -- 0~100 的粗粒度进度，目前只在「识别中」阶段展示为不确定进度之外的补充信息。
  progress tinyint unsigned not null default 0,
  -- 识别结果：segments 为 [{start,end,text}] 数组（秒），srt_text 为可直接导入字幕框的标准 SRT。
  result_json mediumtext null,
  srt_text mediumtext null,
  segment_count int unsigned null,
  -- 实际识别耗时（毫秒，不含排队），用于界面上预估下一次缓存未命中时的等待时间。
  duration_ms bigint null,
  error_message varchar(1000) null,
  requested_by_admin_id bigint unsigned null,
  created_at timestamp not null default current_timestamp,
  updated_at timestamp not null default current_timestamp on update current_timestamp,
  key idx_media_asr_jobs_cache (bucket(64), object_name(191), model_name(64), language(12)),
  key idx_media_asr_jobs_status (status)
);
