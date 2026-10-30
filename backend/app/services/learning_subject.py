"""Keep generated study activities within the subject requested by the user."""

from __future__ import annotations

import re


_PROGRAMMING_TOOLS = (
    r'(?<![a-z0-9])(?:python|java(?:script)?|typescript|kotlin|android|swift|c\+\+|c#|'
    r'c|r|go|golang|rust|ruby|php|scala|lua|perl|dart|flutter|shell|bash|powershell|'
    r'sql|html|css|react|vue|node(?:\.js)?|matlab|pandas|numpy|matplotlib|'
    r'jupyter|scratch|unity|unreal|vba|vscode|pycharm)(?![a-z0-9])'
)
_TECHNOLOGY = re.compile(
    _PROGRAMMING_TOOLS + r'|excel|'
    r'编程|代码|程序设计|软件开发|计算机|数据结构|算法|机器学习|深度学习|'
    r'数据分析|数据科学|网页开发|网站开发|前端|后端|数据库|嵌入式|单片机|编译原理',
    re.IGNORECASE,
)
_NEGATION = re.compile(r'不要|不用|不使用|不需要|无需|不涉及|不要求|禁止|避免|不写|不做|不编程')
_THEORY_COURSE = re.compile(r'毛概|毛泽东思想|马原|马克思主义|思政|思想政治')
_PROGRAMMING_ACTIVITY = re.compile(
    _PROGRAMMING_TOOLS + r'|'
    r'编程|代码|'
    r'(?:编写|实现|运行|调试|执行|测试|提交|解释|检查).{0,12}(?:代码|脚本)|'
    r'(?:编写|调试)(?:一个|一段|简单的)?程序',
    re.IGNORECASE,
)


def positive_clauses(text: str) -> str:
    return '；'.join(clause for clause in re.split(r'[，,；;。\n]|但是|但|却|而|并且|并|同时|然后', text)
                    if not _NEGATION.search(clause))


def programming_is_relevant(topic: str, objective: str, preferences: str) -> bool:
    # Prior knowledge is not permission to add another subject to the goal.
    if re.search(r'(?:不需要|不要求|不要|无需|禁止|不涉及|不安排)(?:任何)?编程|'
                 r'(?:不写|不用|不使用|无需)(?:任何)?(?:代码|程序)', objective + '；' + preferences):
        return False
    return bool(_TECHNOLOGY.search(positive_clauses('；'.join((topic, objective, preferences)))))


def subject_guidance(topic: str, objective: str, preferences: str) -> str:
    if programming_is_relevant(topic, objective, preferences):
        return '按目标选择学习方式；涉及编程时才安排代码，阅读、推导或复习目标也要落实。'
    if _THEORY_COURSE.search(topic):
        return ('本次是理论课程，未要求编程：禁止引入Python、代码实现或运行程序。'
                '围绕指定教材和daily_focus逐日推进，步骤、成果和标题都要对应当天重点，'
                '不能把所有重点每天全部重复。不安排数学推导或阅读虚构的订正过程。'
                '验收写对照教材标出遗漏或错义，不只说确保理解、能回答问题。')
    return ('本次未要求编程：禁止引入Python、代码实现或运行程序。'
            '按本学科安排阅读、概念辨析、推导、口述回忆、答题或错题订正，成果用笔记、答案或讲解。'
            '同一范围学多天也要逐步推进，例如先阅读梳理，再闭卷复述，最后辨析订正；不要每天复制相同步骤。')


def theory_daily_focus(topic: str, objective: str, preferences: str, days: int) -> list[str]:
    if days < 2 or not _THEORY_COURSE.search(topic) or programming_is_relevant(topic, objective, preferences):
        return []
    if days == 2:
        return ['阅读指定原文并整理概念与论点笔记', '闭卷复述并自拟简答题，对照教材订正']
    middle = ['闭卷解释概念并对照原文查漏', '梳理论点与教材依据的关系', '辨析易混概念并写出理由',
              '独立回答自拟简答题并订正', '回顾前日错漏并再次闭卷复述']
    return ['阅读指定原文并整理概念与论点笔记',
            *(middle[index % len(middle)] for index in range(days - 2)),
            '整理本节知识框架并闭卷自测，对照原文订正']


def validate_subject_scope(topic: str, objective: str, preferences: str, content: str) -> None:
    if not programming_is_relevant(topic, objective, preferences):
        unrelated = _PROGRAMMING_ACTIVITY.search(positive_clauses(content))
        if unrelated:
            raise ValueError(f'任务偏离学习主题“{topic}”：未要求编程却安排了“{unrelated.group()}”；'
                             '请按该学科和原始目标重写学习步骤、产出和验收')
