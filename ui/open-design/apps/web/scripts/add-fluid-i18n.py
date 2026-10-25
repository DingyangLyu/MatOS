#!/usr/bin/env python3
"""Backfill lab.fluid.* keys (screen-space fluid rendering toggle)."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'src' / 'i18n'

KEYS = [
    'lab.fluid.toggle',
    'lab.fluid.toggleHintFluid',
    'lab.fluid.toggleHintClassic',
    'lab.fluid.unavailable',
]

T = {
 'en': ['Fluid',
  'Liquid quality: screen-space fluid (click for classic)',
  'Liquid quality: classic (click for screen-space fluid)',
  'Screen-space fluid rendering is unavailable on this GPU — classic liquid look active'],
 'zh-CN': ['流体',
  '液体质量：屏幕空间流体渲染（点击切换为经典）',
  '液体质量：经典（点击切换为屏幕空间流体）',
  '此 GPU 不支持屏幕空间流体渲染——已使用经典液体效果'],
 'zh-TW': ['流體',
  '液體品質：螢幕空間流體渲染（點擊切換為經典）',
  '液體品質：經典（點擊切換為螢幕空間流體）',
  '此 GPU 不支援螢幕空間流體渲染——已使用經典液體效果'],
 'ja': ['流体',
  '液体品質：スクリーンスペース流体（クリックでクラシックへ）',
  '液体品質：クラシック（クリックでスクリーンスペース流体へ）',
  'この GPU ではスクリーンスペース流体レンダリングを利用できません——クラシック表示を使用中'],
 'ko': ['유체',
  '액체 품질: 스크린 스페이스 유체(클릭하면 클래식으로)',
  '액체 품질: 클래식(클릭하면 스크린 스페이스 유체로)',
  '이 GPU에서는 스크린 스페이스 유체 렌더링을 사용할 수 없습니다 — 클래식 표현 사용 중'],
 'de': ['Fluid',
  'Flüssigkeitsqualität: Screen-Space-Fluid (Klick für klassisch)',
  'Flüssigkeitsqualität: klassisch (Klick für Screen-Space-Fluid)',
  'Screen-Space-Fluid-Rendering ist auf dieser GPU nicht verfügbar — klassische Darstellung aktiv'],
 'fr': ['Fluide',
  'Qualité du liquide : fluide en espace écran (cliquez pour le rendu classique)',
  'Qualité du liquide : classique (cliquez pour le fluide en espace écran)',
  'Le rendu de fluide en espace écran n\u2019est pas disponible sur ce GPU — rendu classique actif'],
 'es-ES': ['Fluido',
  'Calidad del líquido: fluido en espacio de pantalla (clic para clásico)',
  'Calidad del líquido: clásico (clic para fluido en espacio de pantalla)',
  'El renderizado de fluidos en espacio de pantalla no está disponible en esta GPU — aspecto clásico activo'],
 'it': ['Fluido',
  'Qualità del liquido: fluido screen-space (clic per il look classico)',
  'Qualità del liquido: classico (clic per il fluido screen-space)',
  'Il rendering fluido screen-space non è disponibile su questa GPU — aspetto classico attivo'],
 'pt-BR': ['Fluido',
  'Qualidade do líquido: fluido em screen space (clique para o clássico)',
  'Qualidade do líquido: clássico (clique para o fluido em screen space)',
  'O render de fluido em screen space não está disponível nesta GPU — visual clássico ativo'],
 'ru': ['Жидкость',
  'Качество жидкости: экранный флюид (нажмите для классики)',
  'Качество жидкости: классика (нажмите для экранного флюида)',
  'Экранный рендеринг жидкости недоступен на этой GPU — используется классический вид'],
 'uk': ['Рідина',
  'Якість рідини: екранний флюїд (натисніть для класики)',
  'Якість рідини: класика (натисніть для екранного флюїда)',
  'Екранний рендеринг рідини недоступний на цій GPU — використовується класичний вигляд'],
 'pl': ['Płyn',
  'Jakość cieczy: fluid screen-space (kliknij, aby wrócić do klasyki)',
  'Jakość cieczy: klasyczna (kliknij, aby włączyć fluid screen-space)',
  'Renderowanie cieczy screen-space jest niedostępne na tym GPU — aktywny klasyczny wygląd'],
 'tr': ['Akışkan',
  'Sıvı kalitesi: ekran uzayı akışkanı (klasik için tıklayın)',
  'Sıvı kalitesi: klasik (ekran uzayı akışkanı için tıklayın)',
  'Ekran uzayı akışkan render bu GPU\u2019da kullanılamıyor — klasik görünüm etkin'],
 'id': ['Fluida',
  'Kualitas cairan: fluida screen-space (klik untuk klasik)',
  'Kualitas cairan: klasik (klik untuk fluida screen-space)',
  'Render fluida screen-space tidak tersedia di GPU ini — tampilan klasik aktif'],
 'th': ['ของไหล',
  'คุณภาพของเหลว: ของไหลแบบ screen-space (คลิกเพื่อใช้แบบคลาสสิก)',
  'คุณภาพของเหลว: คลาสสิก (คลิกเพื่อใช้ของไหลแบบ screen-space)',
  'GPU นี้ไม่รองรับการเรนเดอร์ของไหลแบบ screen-space — ใช้การแสดงผลแบบคลาสสิก'],
 'ar': ['سائل',
  'جودة السائل: سائل بفضاء الشاشة (انقر للمظهر الكلاسيكي)',
  'جودة السائل: كلاسيكي (انقر لسائل فضاء الشاشة)',
  'عرض السوائل بفضاء الشاشة غير متاح على هذه البطاقة الرسومية — المظهر الكلاسيكي مفعّل'],
 'fa': ['سیال',
  'کیفیت مایع: سیال فضای صفحه (برای حالت کلاسیک کلیک کنید)',
  'کیفیت مایع: کلاسیک (برای سیال فضای صفحه کلیک کنید)',
  'رندر سیال فضای صفحه روی این GPU در دسترس نیست — نمای کلاسیک فعال است'],
 'hu': ['Folyadék',
  'Folyadékminőség: képernyőtér-fluid (kattints a klasszikushoz)',
  'Folyadékminőség: klasszikus (kattints a képernyőtér-fluidhoz)',
  'A képernyőtér-alapú folyadékrenderelés nem érhető el ezen a GPU-n — klasszikus megjelenés aktív'],
}

assert all(len(v) == len(KEYS) for v in T.values()), {
    k: len(v) for k, v in T.items() if len(v) != len(KEYS)
}


def insert(path: Path, block: list[str], marker: str) -> None:
    text = path.read_text()
    if marker in text:
        print(f'{path.name}: already present')
        return
    lines = text.split('\n')
    last = max(i for i, line in enumerate(lines) if re.match(r"\s*['\"]lab\.", line))
    lines[last + 1 : last + 1] = block
    path.write_text('\n'.join(lines))
    print(f'{path.name}: +{len(block)}')


types_path = ROOT / 'types.ts'
indent = re.match(
    r'(\s*)',
    [l for l in types_path.read_text().split('\n') if re.match(r"\s*'lab\.", l)][-1],
).group(1)
insert(types_path, [f"{indent}'{key}': string;" for key in KEYS], "'lab.fluid.toggle'")

for code, values in T.items():
    path = ROOT / 'locales' / f'{code}.ts'
    sample = [l for l in path.read_text().split('\n') if re.match(r"\s*['\"]lab\.", l)][-1]
    ind = re.match(r'(\s*)', sample).group(1)
    quote = '"' if sample.lstrip().startswith('"') else "'"
    block = []
    for key, value in zip(KEYS, values):
        if quote == '"':
            escaped = value.replace('\\', '\\\\').replace('"', '\\"')
            block.append(f'{ind}"{key}": "{escaped}",')
        else:
            escaped = value.replace('\\', '\\\\').replace("'", "\\'")
            block.append(f"{ind}'{key}': '{escaped}',")
    insert(path, block, 'lab.fluid.toggle')

print('done')
