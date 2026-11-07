"""把 design/panel-mock.html 渲染成截图（相对路径，随便 clone 到哪都能跑）"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
MOCK = (HERE / "panel-mock.html").as_uri()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/chromium")
        pg = await b.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
        await pg.goto(MOCK)
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=str(HERE / "mock-full.png"))
        await b.close()
        print("->", HERE / "mock-full.png")


asyncio.run(main())
