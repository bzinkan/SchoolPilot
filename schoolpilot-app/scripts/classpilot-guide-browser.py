from pathlib import Path
from tempfile import gettempdir

from playwright.sync_api import expect, sync_playwright


BASE_URL = "http://127.0.0.1:4173"
FORBIDDEN_TERMS = (
    "live view",
    "live-view",
    "interactive streaming",
    "camera monitoring",
    "ip allowlist",
    "manual device assignment",
)


def auth_payload(role, mailpilot_entitled=False):
    return {
        "user": {
            "id": f"{role}-user",
            "email": f"{role}@example.edu",
            "firstName": "Guide",
            "lastName": "Tester",
            "isSuperAdmin": False,
        },
        "memberships": [{
            "id": f"membership-{role}",
            "schoolId": "guide-school",
            "schoolName": "Flight Plan Academy",
            "schoolTimezone": "America/New_York",
            "role": role,
            "roles": [role],
            "primaryRole": role,
            "mailpilotEntitled": mailpilot_entitled,
            "classpilotEmailMonitoring": mailpilot_entitled,
        }],
        "licenses": {"classPilot": True},
        "activeSchoolId": "guide-school",
        "schoolSelectionRequired": False,
    }


def install_routes(context, payload):
    context.route("**/api/**", lambda route: route.fulfill(status=404, json={"error": "browser fixture"}))
    context.route("**/api/auth/me", lambda route: route.fulfill(json=payload))


def assert_no_retired_copy(page):
    copy = page.locator("main").inner_text().lower()
    for term in FORBIDDEN_TERMS:
        assert term not in copy, f"retired guide term rendered: {term}"


def exercise_teacher(browser, screenshot_dir):
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    install_routes(context, auth_payload("teacher"))
    page = context.new_page()
    page.emulate_media(reduced_motion="reduce")
    page.goto(f"{BASE_URL}/classpilot/my-settings/guide", wait_until="networkidle")
    expect(page.get_by_role("heading", name="Teach with a clear route from bell to wrap-up.")).to_be_visible()
    expect(page.get_by_role("link", name="Teacher Guide")).to_have_attribute("aria-current", "page")
    assert page.locator('a[href^="/classpilot/admin"], a[href="/classpilot/settings"]').count() == 0
    assert_no_retired_copy(page)

    search = page.get_by_role("textbox", name="Search the flight plan")
    search.fill("signed out")
    expect(page.locator("#guide-search-results")).to_contain_text("matching “signed out”")
    expect(page.get_by_role("heading", name="Use Waypoints and Flight Paths")).to_be_visible()
    search.fill("no-route-should-match-this")
    expect(page.get_by_role("heading", name="No route matches that search")).to_be_visible()
    page.get_by_role("button", name="Clear search").click()

    page.locator("aside").get_by_role("button", name="Open a URL and manage tabs", exact=False).click()
    expect(page).to_have_url(f"{BASE_URL}/classpilot/my-settings/guide?topic=open-url-and-tabs")
    page.go_back(wait_until="networkidle")
    expect(page).to_have_url(f"{BASE_URL}/classpilot/my-settings/guide")

    page.get_by_test_id("button-theme-toggle").click()
    assert page.locator("html").evaluate("node => node.classList.contains('dark')")
    page.get_by_test_id("button-theme-toggle").click()

    page.goto(f"{BASE_URL}/classpilot/my-settings/guide?topic=waypoints-and-flight-paths", wait_until="networkidle")
    expect(page.locator("#topic-waypoints-and-flight-paths summary")).to_be_focused()
    expect(page.locator("#topic-waypoints-and-flight-paths")).to_have_attribute("open", "")
    page.screenshot(path=str(screenshot_dir / "classpilot-teacher-guide.png"), full_page=True)

    page.set_viewport_size({"width": 390, "height": 844})
    expect(page.locator("#guide-topic-select")).to_be_visible()
    page.locator("#guide-topic-select").select_option("coverage-workflow")
    expect(page).to_have_url(f"{BASE_URL}/classpilot/my-settings/guide?topic=coverage-workflow")

    page.goto(f"{BASE_URL}/classpilot/settings/guide", wait_until="domcontentloaded")
    page.wait_for_url(f"{BASE_URL}/classpilot")
    context.close()


def exercise_admin(browser, screenshot_dir, entitled):
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    install_routes(context, auth_payload("school_admin", mailpilot_entitled=entitled))
    page = context.new_page()
    page.goto(f"{BASE_URL}/classpilot/settings/guide?topic=student-sign-in-policy", wait_until="networkidle")
    expect(page.get_by_role("heading", name="Launch, govern, and support the whole ClassPilot program.")).to_be_visible()
    expect(page.get_by_role("link", name="Admin Guide")).to_have_attribute("aria-current", "page")
    expect(page.locator("#topic-student-sign-in-policy summary")).to_be_focused()
    expect(page.get_by_text("restrictionAuthPassThroughV1", exact=False)).to_be_visible()
    assert_no_retired_copy(page)
    if entitled:
        expect(page.get_by_role("heading", name="Operate Email Monitoring")).to_be_visible()
        page.screenshot(path=str(screenshot_dir / "classpilot-admin-guide.png"), full_page=True)
    else:
        expect(page.get_by_role("heading", name="Operate Email Monitoring")).to_have_count(0)
    context.close()


def main():
    screenshot_dir = Path(gettempdir()) / "classpilot-guide-smoke"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        exercise_teacher(browser, screenshot_dir)
        exercise_admin(browser, screenshot_dir, entitled=True)
        exercise_admin(browser, screenshot_dir, entitled=False)
        browser.close()
    print(f"ClassPilot guide browser smoke passed; screenshots: {screenshot_dir}")


if __name__ == "__main__":
    main()
