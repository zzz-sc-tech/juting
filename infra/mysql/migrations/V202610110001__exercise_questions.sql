-- 模拟实战模式：听力选择题（题干行定位 + 四选项文本）。
-- JSON 数组，每项 { "n": 1..25, "stemLineId": "lN" | null, "options": { "A": "...", "B": "...", "C": "...", "D": "..." } }。
-- 答案字母不在此列（权威在 answer_key_json，避免双源漂移）；null = 该课未导入选择题。
set names utf8mb4;
alter table exercises
  add column questions_json json null after answer_key_json;
