from difflib import SequenceMatcher
import re


def _activities(notes: str) -> str:
    text = re.split(r'产出[：:]|成果[：:]', notes, maxsplit=1)[0]
    text = re.sub(r'\d+(?:\.\d+)?\s*(?:分钟|min)|第[一二三四五六七八九十百\d]+[天日项个]', '', text, flags=re.I)
    return re.sub(r'[^\w\u4e00-\u9fff]|[\d_]', '', text).casefold()


def actionable_verification(verification: str, activities: str) -> str:
    """Give a vague generated check an executable method without inventing answers."""
    vague = len(verification.strip()) < 14 or any(phrase in verification for phrase in (
        '确保理解', '保证理解', '确保掌握', '检查是否理解', '确认理解',
    ))
    if not vague or re.search(r'对照|核对|订正|误差|正确率|预期|一致|标出', verification):
        return verification
    if re.search(r'波形|包络|调幅|过调制', activities):
        return '不看笔记独立标注当天波形，再对照参考图核对包络、载波和失真部位，标出并订正差异'
    if re.search(r'计算|公式|推导|求解|单位|量纲', activities):
        return '独立重算当天例题或推导，对照公式逐步核对代入、单位和数量级，记录并订正差异'
    if re.search(r'代码|程序|脚本|函数|API|CSV', activities, re.I):
        return '用正常输入和边界输入实际执行当天功能，逐项核对预期输出，记录失败用例并修正'
    if re.search(r'口语|朗读|录音|发音', activities):
        return '不看提纲录音复述当天话题，回听并检查漏点、用词和停顿，记录重说前后的差异'
    return '合上资料复述当天成果的主要概念，再对照原文逐项标出遗漏或错义并完成订正'


def validate_task_variety(tasks) -> None:
    signatures = []
    for index, task in enumerate(tasks):
        verification = re.split(r'验收[：:]|自测[：:]|检查[：:]', task.notes)[-1]
        if re.match(r'^(?:确保|保证|确认)(?:已经|能够|能|已)?(?:理解|掌握|熟悉|学会)', verification.strip()):
            if not re.search(r'对照|核对|闭卷|测试|错题|\d+|复现|举例|算出|计算结果|复述', verification):
                raise ValueError(f'第{index + 1}天的验收过于含糊，请写出对照、答题、推导或测试的具体检查动作，不能只说确保理解')
        signature = _activities(task.notes)
        if len(signature) < 12:
            continue
        for previous, other in signatures:
            ratio = SequenceMatcher(None, other, signature, autojunk=False).ratio()
            boilerplate = all(phrase in task.notes and phrase in tasks[previous].notes
                              for phrase in ('阅读教材', '相关章节', '笔记记录'))
            if ratio >= .90 or boilerplate:
                raise ValueError(f'第{index + 1}天与第{previous + 1}天的学习步骤高度重复，不能只替换日期或知识点名称；'
                                 '请分别安排具体概念、例题、操作或递进成果')
        signatures.append((index, signature))
