"""Read-only, explainable natural-language filters and evidence-based comparisons."""
from __future__ import annotations

import calendar
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AgendaItem, DailyActivity, Dish, LearningGoal, LearningTask, MealPlan, QuickNote,
    StudyFocusSession, StudySession,
)

CATEGORIES = {
    "all": "全部", "learning": "学习", "diet": "饮食", "exercise": "运动",
    "work": "工作", "health": "健康", "life": "生活", "leisure": "休闲",
    "other": "其他", "notes": "备忘",
}
CATEGORY_WORDS = {
    "learning": "学习|学什么|学了|打算学", "diet": "饮食|餐食|吃饭|吃了",
    "exercise": "运动|锻炼|跑步", "work": "工作", "health": "健康",
    "life": "生活", "leisure": "休闲", "other": "其他", "notes": "备忘|便签",
}
COMPARISON_NOTE = (
    "按计划日期统计完成状态；日常活动不等于任务完成。手动学习记录与专注计时可能重叠，分别展示、不相加；未记录不代表实际为零。"
)


@dataclass
class SearchIntent:
    keyword: str = ""
    category: str = "all"
    status: str = "all"
    start_date: date | None = None
    end_date: date | None = None
    mode: str = "search"


def chinese_number(value: str) -> int:
    if value.isdigit():
        return int(value)
    digits = {char: index for index, char in enumerate("零一二三四五六七八九")}
    if value == "两":
        return 2
    if "十" in value:
        left, right = value.split("十", 1)
        return (digits.get(left, 1) if left else 1) * 10 + digits.get(right, 0)
    return digits.get(value, 0)


def parse_query(query: str, today: date) -> SearchIntent:
    text = query.strip()
    if not text:
        raise ValueError("请输入关键词或问题")
    intent = SearchIntent()
    if re.search(r"对照|对比|复盘|计划.*实际|打算.*实际|实际.*(完成|多少)|完成得怎么样", text):
        intent.mode = "compare"
    dates = re.findall(r"\d{4}-\d{2}-\d{2}", text)
    if dates:
        if len(dates) > 2:
            raise ValueError("最多指定两个日期")
        intent.start_date = date.fromisoformat(dates[0])
        intent.end_date = date.fromisoformat(dates[-1])
        text = re.sub(r"\d{4}-\d{2}-\d{2}", " ", text)
        text = re.sub(r"(?<!\w)(?:从|到|至|~|～)(?!\w)", " ", text)
    else:
        recent = re.search(r"(?:最近|近)([\d零一二三四五六七八九十两]+)天", text)
        if recent:
            days = chinese_number(recent[1])
            if not 1 <= days <= 366:
                raise ValueError("最近天数需要在 1 至 366 天之间")
            intent.start_date, intent.end_date = today - timedelta(days=days - 1), today
            text = text.replace(recent[0], " ")
        else:
            for word, delta in (("前天", 2), ("昨天", 1), ("昨日", 1), ("今天", 0), ("今日", 0)):
                if word in text:
                    intent.start_date = intent.end_date = today - timedelta(days=delta)
                    text = text.replace(word, " ")
                    break
            if intent.start_date is None and re.search("上周|本周|这周", text):
                start = today - timedelta(days=today.weekday())
                if "上周" in text:
                    start -= timedelta(days=7)
                intent.start_date, intent.end_date = start, start + timedelta(days=6)
                text = re.sub("上周|本周|这周", " ", text)
            if intent.start_date is None and re.search("上个月|上月|本月|这个月", text):
                start = today.replace(day=1)
                if re.search("上个月|上月", text):
                    start = (start - timedelta(days=1)).replace(day=1)
                intent.start_date = start
                intent.end_date = start.replace(day=calendar.monthrange(start.year, start.month)[1])
                text = re.sub("上个月|上月|本月|这个月", " ", text)
    for state, expression in (
        ("pending", "还没有完成|没有完成|还没完成|没完成|未完成|待完成|没做完|未做完"),
        ("completed", "已经完成|已完成|做完了的|已做完"),
    ):
        if re.search(expression, text):
            intent.status = state
            text = re.sub(expression, " ", text)
            break
    quoted = re.search(r'[“"「](.+?)[”"」]', text)
    if quoted:
        intent.keyword = quoted[1].strip()
        text = text.replace(quoted[0], " ")
    for category, expression in CATEGORY_WORDS.items():
        if re.search(expression, text):
            intent.category = category
            text = re.sub(expression, " ", text)
            break
    if not quoted:
        # Supported grammar only: remaining words are literal keywords, not invented semantics.
        fillers = (
            "完成得怎么样|原本打算|原计划|实际完成了多少|实际完成多少|实际完成|完成了多少|"
            "怎么样|有哪些|做了什么|学了什么|打算做什么|多少时间|多少分钟|多长时间|"
            "帮我|找出|查找|搜索|查询|查看|看看|对照|对比|复盘|总结|统计|"
            "计划与实际|实际|原本|打算|完成情况|计划|任务|活动|记录|情况|"
            "我|所有|全部|已经|什么|多少|的|了|在"
        )
        intent.keyword = re.sub(fillers, " ", text)
        intent.keyword = " ".join(re.findall(r"[\w\u4e00-\u9fff]+", intent.keyword))
        if not intent.keyword and not re.search(r"[\w\u4e00-\u9fff]", query):
            intent.keyword = query.strip()
    if intent.mode == "compare" and intent.start_date is None:
        intent.start_date = today - timedelta(days=today.weekday())
        intent.end_date = intent.start_date + timedelta(days=6)
    return intent


def matches(keyword: str, *texts: str) -> bool:
    content = " ".join(texts).casefold()
    return all(word.casefold() in content for word in keyword.split())


def dated(statement, column, intent: SearchIntent):
    if intent.start_date:
        statement = statement.where(column >= intent.start_date)
    if intent.end_date:
        statement = statement.where(column <= intent.end_date)
    return statement


def result(row, module: str, label: str, title: str, content: str, path: str,
           day: date | None = None, state: str | None = None) -> dict:
    return {"id": row.id, "module": module, "type": label, "title": title,
            "snippet": content[:220], "path": path, "date": day, "status": state}


def search_and_compare(session: Session, intent: SearchIntent, today: date,
                       offset_minutes: int = 0) -> dict:
    if bool(intent.start_date) != bool(intent.end_date):
        raise ValueError("请同时指定开始与结束日期")
    if intent.start_date and (intent.end_date < intent.start_date or (intent.end_date - intent.start_date).days > 365):
        raise ValueError("日期范围需按先后排列，且不超过 366 天")
    goals = {row.id: row for row in session.scalars(select(LearningGoal).where(LearningGoal.deleted_at.is_(None)))}
    tasks = {row.id: row for row in session.scalars(select(LearningTask).where(
        LearningTask.deleted_at.is_(None), LearningTask.goal_id.in_(goals),
    ))}
    task_by_agenda = {task.agenda_id: task for task in tasks.values() if task.agenda_id}
    active_meals = set(session.scalars(select(MealPlan.id).where(MealPlan.deleted_at.is_(None))))
    rows: list[dict] = []
    plans: list[AgendaItem] = []
    manual_records: list[StudySession] = []
    focus_rows: list[dict] = []
    activities: list[DailyActivity] = []

    for item in session.scalars(dated(select(AgendaItem).where(
        AgendaItem.deleted_at.is_(None), AgendaItem.status.in_(["pending", "completed"]),
        AgendaItem.module.in_(["general", "learning", "diet"]),
    ), AgendaItem.plan_date, intent)):
        task = tasks.get(item.source_id) or task_by_agenda.get(item.id)
        if item.source_type == "learning_task" and not task:
            continue
        if item.source_type == "meal_plan" and item.source_id not in active_meals:
            continue
        category = "learning" if task or item.module == "learning" else "diet" if item.module == "diet" else "all"
        # General agenda has no category column. Do not infer exercise/work from a vague title.
        if intent.category not in ("all", category):
            continue
        goal = goals.get(task.goal_id) if task else None
        if not matches(intent.keyword, item.title, item.notes, goal.name if goal else "", task.details if task else ""):
            continue
        plans.append(item)
        if intent.status != "all" and item.status != intent.status:
            continue
        path = f"/today?date={item.plan_date}&item={item.id}"
        if goal:
            path = f"/learning?item={goal.id}&task={task.id}"
        rows.append(result(item, category if category != "all" else "today", "学习任务" if goal else "饮食计划" if category == "diet" else "计划",
                           item.title, item.notes, path, item.plan_date, item.status))

    if intent.status == "all":
        for activity in session.scalars(dated(select(DailyActivity).where(DailyActivity.deleted_at.is_(None)), DailyActivity.activity_date, intent)):
            if intent.category not in ("all", activity.category) or not matches(intent.keyword, activity.content):
                continue
            activities.append(activity)
            rows.append(result(activity, "home", "日常记录 · " + CATEGORIES.get(activity.category, "其他"), activity.content,
                               "", f"/?date={activity.activity_date}&activity={activity.id}#daily-activities", activity.activity_date))

    # Comparison evidence ignores the task-status filter, so its denominator is all plans in scope.
    for log in session.scalars(dated(select(StudySession).where(
        StudySession.deleted_at.is_(None), StudySession.goal_id.in_(goals),
    ), StudySession.studied_on, intent)):
        goal = goals[log.goal_id]
        if intent.category not in ("all", "learning") or not matches(intent.keyword, goal.name, log.notes, log.problems, log.next_step):
            continue
        manual_records.append(log)
        if intent.status == "all":
            rows.append(result(log, "learning", "学习记录", goal.name + " · 学习记录", f"{log.actual_minutes} 分钟 · {log.notes}",
                               f"/learning?item={goal.id}&tab=sessions&record={log.id}", log.studied_on))

    local_zone = timezone(timedelta(minutes=-offset_minutes))
    if intent.start_date:
        start = datetime.combine(intent.start_date, time.min, local_zone).astimezone(timezone.utc)
        end = datetime.combine(intent.end_date + timedelta(days=1), time.min, local_zone).astimezone(timezone.utc)
        focus_query = select(StudyFocusSession).where(
            StudyFocusSession.goal_id.in_(goals), StudyFocusSession.ended_at.is_not(None),
            StudyFocusSession.started_at < end, StudyFocusSession.ended_at > start,
        )
        for focus in session.scalars(focus_query):
            goal = goals[focus.goal_id]
            task = tasks.get(focus.task_id)
            if focus.task_id and not task:
                continue
            if intent.category not in ("all", "learning") or not matches(intent.keyword, goal.name, task.title if task else ""):
                continue
            begin = focus.started_at.replace(tzinfo=timezone.utc) if focus.started_at.tzinfo is None else focus.started_at
            finish = focus.ended_at.replace(tzinfo=timezone.utc) if focus.ended_at.tzinfo is None else focus.ended_at
            seconds = max(0, int((min(finish, end) - max(begin, start)).total_seconds()))
            focus_rows.append({"id": focus.id, "seconds": seconds, "goal": goal.name,
                               "path": f"/learning?item={goal.id}", "date": max(begin, start).astimezone(local_zone).date()})

    if intent.status == "all":
        note_query = select(QuickNote).where(QuickNote.deleted_at.is_(None), QuickNote.is_archived.is_(False))
        if intent.start_date:
            note_query = note_query.where(
                QuickNote.created_at >= datetime.combine(intent.start_date, time.min, local_zone).astimezone(timezone.utc),
                QuickNote.created_at < datetime.combine(intent.end_date + timedelta(days=1), time.min, local_zone).astimezone(timezone.utc),
            )
        for note in session.scalars(note_query):
            if intent.category not in ("all", "notes") or not matches(intent.keyword, note.content):
                continue
            created = note.created_at.replace(tzinfo=timezone.utc) if note.created_at.tzinfo is None else note.created_at
            rows.append(result(note, "home", "备忘", note.content[:100], "", f"/?note={note.id}#quick-notes", created.astimezone(local_zone).date()))
        if not intent.start_date:
            for goal in goals.values():
                if intent.category in ("all", "learning") and matches(intent.keyword, goal.name, goal.goal):
                    rows.append(result(goal, "learning", "学习目标", goal.name, goal.goal, f"/learning?item={goal.id}"))
            if intent.category in ("all", "diet"):
                for dish in session.scalars(select(Dish).where(Dish.deleted_at.is_(None))):
                    if matches(intent.keyword, dish.name, dish.instructions):
                        rows.append(result(dish, "diet", "菜品", dish.name, dish.instructions, f"/diet?dish={dish.id}"))

    # Activities remain separate evidence, never automatic completion or inferred minutes.
    if intent.status != "all":
        activities = [row for row in session.scalars(dated(select(DailyActivity).where(DailyActivity.deleted_at.is_(None)), DailyActivity.activity_date, intent))
                      if intent.category in ("all", row.category) and matches(intent.keyword, row.content)]
    estimates = [int(match[1]) for row in plans if (row.module == "learning" or row.id in task_by_agenda)
                 and (match := re.search(r"(?m)^预计 (\d+) 分钟$", row.notes))]
    learning_count = sum(row.module == "learning" or row.id in task_by_agenda for row in plans)
    rows.sort(key=lambda row: (str(row["date"] or ""), row["type"], row["id"]), reverse=True)
    counts = {state: sum(row.status == state for row in plans) for state in ("pending", "completed")}
    comparison = {
        "planned_count": len(plans), "completed_count": counts["completed"], "pending_count": counts["pending"],
        "completion_rate": round(counts["completed"] / len(plans) * 100, 1) if plans else None,
        "planned_learning_minutes": sum(estimates) if estimates else None,
        "missing_estimate_count": learning_count - len(estimates),
        "manual_learning_minutes": sum(log.actual_minutes for log in manual_records) if manual_records else None,
        "manual_record_count": len(manual_records),
        "focus_minutes": round(sum(row["seconds"] for row in focus_rows) / 60, 1) if focus_rows else None,
        "focus_record_count": len(focus_rows), "activity_count": len(activities),
        "note": COMPARISON_NOTE,
        "evidence": [result(row, "today", "计划", row.title, row.notes, f"/today?date={row.plan_date}&item={row.id}", row.plan_date, row.status) for row in plans]
        + [result(log, "learning", "学习记录", goals[log.goal_id].name, f"手动记录 {log.actual_minutes} 分钟", f"/learning?item={log.goal_id}&tab=sessions&record={log.id}", log.studied_on) for log in manual_records]
        + [{"id": row["id"], "module": "learning", "type": "专注计时", "title": row["goal"], "snippet": f"区间内 {round(row['seconds'] / 60, 1)} 分钟", "path": row["path"], "date": row["date"], "status": None} for row in focus_rows]
        + [result(row, "home", "日常记录", row.content, "不据此自动判定任务完成", f"/?date={row.activity_date}&activity={row.id}#daily-activities", row.activity_date) for row in activities],
    }
    # No summary is computed over truncated results: the UI limit only affects evidence display.
    total_evidence = len(comparison["evidence"])
    comparison["evidence"] = comparison["evidence"][:100]
    comparison["evidence_count"] = total_evidence
    warnings = ["支持固定时间、类别、状态与关键词组合；识别不准确时可修改下方条件。"]
    if intent.end_date and intent.end_date > today:
        warnings.append("所选区间包含未来日期，未完成数量可能包含尚未到期的安排。")
    if intent.status != "all":
        warnings.append("完成状态仅筛选计划结果；对照统计仍包含同一时间、类别和关键词下的全部计划。")
    if intent.category not in ("all", "learning", "diet", "notes"):
        warnings.append("该类别来自日常记录；普通手动计划没有活动分类，不自动推断归属。")
    if not intent.start_date:
        warnings.append("未指定日期，搜索所有日期；选择时间区间后可查看专注计时对照。")
    return {"interpretation": asdict(intent), "results": rows[:100], "total_count": len(rows),
            "comparison": comparison, "warnings": warnings}
