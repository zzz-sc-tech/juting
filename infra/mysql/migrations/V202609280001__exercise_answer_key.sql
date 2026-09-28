-- 课程真题答案钥匙：听力 25 题的正确选项。
-- 存 JSON 对象（题号字符串 → 选项字母），允许部分导入：{"1":"A","2":"C"}。
-- 为空表示该课程还没有答案数据，学习端不显示对答案入口。
set names utf8mb4;

alter table exercises
  add column answer_key_json json null after localizations_json;
