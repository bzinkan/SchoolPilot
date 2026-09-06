"""Run with webapp-testing's with_server.py and Vite on port 4188."""
import asyncio
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width":1440,"height":1100},service_workers="block")
        errors, requests, aborted = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("requestfailed", lambda request: aborted.append(request.url))
        async def route_api(route):
            parsed=urlparse(route.request.url)
            if "browsing-history" not in parsed.path:
                await route.fulfill(content_type="application/json",body=json.dumps({"user":{"id":"teacher-a"},"memberships":[{"id":"membership-a","schoolId":"school-a","role":"teacher"}],"licenses":{},"events":[],"csrfToken":"fixture-token"}))
                return
            query=parse_qs(parsed.query);start=query.get("startDate",["2026-09-01"])[0];cursor=query.get("cursor",[None])[0]
            requests.append({"start":start,"cursor":cursor,"path":parsed.path})
            meta={"studentId":"student-a","timeZone":"America/New_York","startDate":start,"endDate":query.get("endDate",[start])[0],"today":"2026-09-01","retentionDays":30,"scope":"supervised_intervals","partiallyExpired":False}
            status=200
            if parsed.path.endswith("/domains"):
                body={**meta,"state":"available","days":[{"date":start,"computedAt":"2026-09-01T18:00:00Z","domains":[{"domain":"classroom.google.com","seconds":120,"contentCategory":None}]}]}
            elif start=="2026-08-31":body={**meta,"state":"empty","entries":[],"nextCursor":None}
            elif start=="2026-08-01":body={**meta,"state":"expired","entries":[],"nextCursor":None}
            elif start in ["2026-08-30","2026-08-29","2026-08-28"]:
                state,status={"2026-08-30":("denied",403),"2026-08-29":("unavailable",503),"2026-08-28":("failed",500)}[start]
                body={"state":state,"error":"Fixture response"}
            else:
                if start=="2026-08-21":await asyncio.sleep(1.5)
                body={**meta,"state":"available","entries":[{"id":"older" if cursor else "first","timestamp":"2026-09-01T13:00:00.123456Z","activeTabUrl":"https://classroom.google.com","activeTabTitle":"Older observation" if cursor else ("Stale observation" if start=="2026-08-21" else "Current observation"),"aiCategory":"educational","contentCategory":None,"estimatedSeconds":5 if cursor else 0}],"nextCursor":None if cursor else "next-fixture-cursor"}
            try:await route.fulfill(status=status,content_type="application/json",body=json.dumps(body))
            except Exception:
                if start!="2026-08-21":raise
        await page.route("**/api/**",route_api)
        await page.goto("http://127.0.0.1:4188/browsing-history-regression.html",wait_until="networkidle")
        await page.get_by_test_id("tab-history").click()
        await page.get_by_text("Current observation",exact=True).wait_for()
        assert await page.get_by_label("History start date").input_value()=="2026-09-01"
        assert "America/New_York" in await page.get_by_test_id("student-browsing-history").inner_text()
        await page.get_by_role("button",name="Load older observations").click()
        await page.get_by_text("Older observation",exact=True).wait_for()
        assert await page.get_by_test_id("history-observation").count()==2
        assert any(item["cursor"]=="next-fixture-cursor" for item in requests)
        for date,text in [("2026-08-31","No observations were recorded"),("2026-08-01","outside the school’s browsing retention"),("2026-08-30","You can view browsing only"),("2026-08-29","temporarily unavailable"),("2026-08-28","history request failed")]:
            await page.get_by_label("History start date").fill(date)
            await page.get_by_text(text,exact=False).last.wait_for()
            assert await page.get_by_test_id("history-observation").count()==0
        await page.get_by_label("History start date").fill("2026-08-21")
        await page.wait_for_timeout(100)
        await page.get_by_label("History start date").fill("2026-08-31")
        await page.get_by_text("No observations were recorded",exact=False).wait_for()
        await page.wait_for_timeout(1700)
        assert await page.get_by_text("Stale observation",exact=True).count()==0
        assert any("startDate=2026-08-21" in url for url in aborted),"Superseded history request was aborted"
        await page.get_by_role("button",name="Today",exact=True).click()
        await page.get_by_text("Current observation",exact=True).wait_for()
        artifacts=Path(__file__).resolve().parents[1]/"artifacts"/"classpilot-roadmap"
        artifacts.mkdir(parents=True,exist_ok=True)
        await page.screenshot(path=str(artifacts/"browsing-history.png"),full_page=True)
        assert not errors,errors
        print("Browsing history browser: actual drawer dates, pagination, school timezone, all states, stale-request abortion passed.")
        await browser.close()

asyncio.run(main())
