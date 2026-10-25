#!/usr/bin/env python3
"""Backfill lab.sandboxPhoto* keys (path-traced photo mode)."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'src' / 'i18n'

KEYS = [
    'lab.sandboxPhoto', 'lab.sandboxPhotoHint', 'lab.sandboxPhotoTitle',
    'lab.sandboxPhotoPreparing', 'lab.sandboxPhotoProgress',
    'lab.sandboxPhotoNote', 'lab.sandboxPhotoFailed', 'lab.sandboxPhotoSave',
]

T = {
 'en': ['Photo', 'Path-traced render of the current view (physics freezes while samples accumulate)',
  'Photo render', 'Building ray-tracing acceleration structure…', '{samples}/{target} samples',
  'Real path tracing: glass refraction and soft shadows. Liquid levels are approximated. Save anytime — more samples, less noise.',
  'Renderer failed to start (WebGL2 required)', 'Save PNG'],
 'zh-CN': ['照片', '对当前画面做路径追踪渲染（物理冻结，采样逐步累积）',
  '照片渲染', '构建光线追踪加速结构…', '{samples}/{target} 采样',
  '真实路径追踪：玻璃折射与软阴影。液位为近似显示。随时可保存——采样越多噪点越少。',
  '渲染器启动失败（需要 WebGL2）', '保存 PNG'],
 'zh-TW': ['照片', '對當前畫面做路徑追蹤渲染（物理凍結，取樣逐步累積）',
  '照片渲染', '建立光線追蹤加速結構…', '{samples}/{target} 取樣',
  '真實路徑追蹤：玻璃折射與軟陰影。液位為近似顯示。隨時可儲存——取樣越多雜訊越少。',
  '渲染器啟動失敗（需要 WebGL2）', '儲存 PNG'],
 'ja': ['写真', '現在のビューをパストレーシングでレンダリング（物理は凍結、サンプルを蓄積）',
  '写真レンダリング', 'レイトレーシング加速構造を構築中…', '{samples}/{target} サンプル',
  '本物のパストレーシング：ガラスの屈折とソフトシャドウ。液面は近似表示です。いつでも保存可能——サンプルが多いほどノイズが減ります。',
  'レンダラーの起動に失敗（WebGL2 が必要）', 'PNG を保存'],
 'ko': ['사진', '현재 화면을 패스 트레이싱으로 렌더링(물리 정지, 샘플 누적)',
  '사진 렌더링', '레이 트레이싱 가속 구조 구축 중…', '{samples}/{target} 샘플',
  '실제 패스 트레이싱: 유리 굴절과 부드러운 그림자. 액체 수위는 근사치입니다. 언제든 저장 가능 — 샘플이 많을수록 노이즈가 줄어듭니다.',
  '렌더러 시작 실패(WebGL2 필요)', 'PNG 저장'],
 'de': ['Foto', 'Path-Tracing-Render der aktuellen Ansicht (Physik pausiert, Samples akkumulieren)',
  'Foto-Render', 'Raytracing-Beschleunigungsstruktur wird aufgebaut…', '{samples}/{target} Samples',
  'Echtes Path Tracing: Glasbrechung und weiche Schatten. Flüssigkeitsstände sind angenähert. Jederzeit speichern — mehr Samples, weniger Rauschen.',
  'Renderer-Start fehlgeschlagen (WebGL2 erforderlich)', 'PNG speichern'],
 'fr': ['Photo', 'Rendu par path tracing de la vue actuelle (physique gelée, échantillons accumulés)',
  'Rendu photo', 'Construction de la structure d\u2019accélération…', '{samples}/{target} échantillons',
  'Vrai path tracing : réfraction du verre et ombres douces. Les niveaux de liquide sont approximés. Enregistrez à tout moment — plus d\u2019échantillons, moins de bruit.',
  'Échec du démarrage du moteur (WebGL2 requis)', 'Enregistrer le PNG'],
 'es-ES': ['Foto', 'Render por path tracing de la vista actual (la física se congela mientras se acumulan muestras)',
  'Render de foto', 'Construyendo estructura de aceleración…', '{samples}/{target} muestras',
  'Path tracing real: refracción del vidrio y sombras suaves. Los niveles de líquido son aproximados. Guarda en cualquier momento: más muestras, menos ruido.',
  'Fallo al iniciar el renderizador (se requiere WebGL2)', 'Guardar PNG'],
 'it': ['Foto', 'Render path-traced della vista corrente (fisica congelata, campioni accumulati)',
  'Render foto', 'Costruzione struttura di accelerazione…', '{samples}/{target} campioni',
  'Vero path tracing: rifrazione del vetro e ombre morbide. I livelli dei liquidi sono approssimati. Salva in qualsiasi momento: più campioni, meno rumore.',
  'Avvio del renderer non riuscito (richiede WebGL2)', 'Salva PNG'],
 'pt-BR': ['Foto', 'Render por path tracing da vista atual (física congela enquanto amostras acumulam)',
  'Render de foto', 'Construindo estrutura de aceleração…', '{samples}/{target} amostras',
  'Path tracing real: refração do vidro e sombras suaves. Níveis de líquido são aproximados. Salve a qualquer momento — mais amostras, menos ruído.',
  'Falha ao iniciar o renderizador (WebGL2 necessário)', 'Salvar PNG'],
 'ru': ['Фото', 'Рендер текущего вида трассировкой путей (физика замирает, сэмплы накапливаются)',
  'Фоторендер', 'Построение ускоряющей структуры…', '{samples}/{target} сэмплов',
  'Настоящая трассировка путей: преломление стекла и мягкие тени. Уровни жидкости приблизительны. Сохраняйте в любой момент — больше сэмплов, меньше шума.',
  'Не удалось запустить рендерер (нужен WebGL2)', 'Сохранить PNG'],
 'uk': ['Фото', 'Рендер поточного виду трасуванням шляхів (фізика завмирає, семпли накопичуються)',
  'Фоторендер', 'Побудова прискорювальної структури…', '{samples}/{target} семплів',
  'Справжнє трасування шляхів: заломлення скла та м\u2019які тіні. Рівні рідини приблизні. Зберігайте будь-коли — більше семплів, менше шуму.',
  'Не вдалося запустити рендерер (потрібен WebGL2)', 'Зберегти PNG'],
 'pl': ['Zdjęcie', 'Render path tracingiem bieżącego widoku (fizyka zamrożona, próbki się kumulują)',
  'Render zdjęcia', 'Budowanie struktury przyspieszającej…', '{samples}/{target} próbek',
  'Prawdziwy path tracing: załamanie szkła i miękkie cienie. Poziomy cieczy są przybliżone. Zapisuj w dowolnym momencie — więcej próbek, mniej szumu.',
  'Nie udało się uruchomić renderera (wymagany WebGL2)', 'Zapisz PNG'],
 'tr': ['Fotoğraf', 'Geçerli görünümün path tracing render\u0131 (fizik donar, örnekler birikir)',
  'Fotoğraf render', 'Işın izleme hızlandırma yapısı kuruluyor…', '{samples}/{target} örnek',
  'Gerçek path tracing: cam kırılması ve yumuşak gölgeler. Sıvı seviyeleri yaklaşıktır. İstediğiniz an kaydedin — daha çok örnek, daha az gürültü.',
  'Renderer başlatılamadı (WebGL2 gerekli)', 'PNG kaydet'],
 'id': ['Foto', 'Render path tracing dari tampilan saat ini (fisika beku saat sampel terakumulasi)',
  'Render foto', 'Membangun struktur akselerasi…', '{samples}/{target} sampel',
  'Path tracing nyata: refraksi kaca dan bayangan lembut. Level cairan adalah aproksimasi. Simpan kapan saja — semakin banyak sampel, semakin sedikit noise.',
  'Renderer gagal dimulai (perlu WebGL2)', 'Simpan PNG'],
 'th': ['ภาพถ่าย', 'เรนเดอร์มุมมองปัจจุบันด้วย path tracing (ฟิสิกส์หยุดชั่วคราวระหว่างสะสมตัวอย่าง)',
  'เรนเดอร์ภาพถ่าย', 'กำลังสร้างโครงสร้างเร่งการติดตามรังสี…', '{samples}/{target} ตัวอย่าง',
  'Path tracing จริง: การหักเหของแก้วและเงานุ่ม ระดับของเหลวเป็นค่าประมาณ บันทึกได้ทุกเมื่อ — ตัวอย่างมากขึ้น สัญญาณรบกวนน้อยลง',
  'เริ่มตัวเรนเดอร์ไม่สำเร็จ (ต้องใช้ WebGL2)', 'บันทึก PNG'],
 'ar': ['صورة', 'عرض بتتبع المسار للمشهد الحالي (تتجمد الفيزياء بينما تتراكم العينات)',
  'عرض الصورة', 'يجري بناء هيكل تسريع تتبع الأشعة…', '{samples}/{target} عينة',
  'تتبع مسار حقيقي: انكسار الزجاج والظلال الناعمة. مستويات السوائل تقريبية. احفظ في أي وقت — عينات أكثر، ضوضاء أقل.',
  'فشل بدء المعرض (يتطلب WebGL2)', 'حفظ PNG'],
 'fa': ['عکس', 'رندر مسیرِ نور از نمای فعلی (فیزیک متوقف می‌شود و نمونه‌ها انباشته می‌شوند)',
  'رندر عکس', 'در حال ساخت ساختار شتاب‌دهی ردیابی پرتو…', '{samples}/{target} نمونه',
  'ردیابی مسیر واقعی: شکست شیشه و سایه‌های نرم. سطح مایعات تقریبی است. هر زمان ذخیره کنید — نمونه بیشتر، نویز کمتر.',
  'راه‌اندازی رندرکننده ناموفق بود (WebGL2 لازم است)', 'ذخیره PNG'],
 'hu': ['Fotó', 'Az aktuális nézet path-traced renderelése (a fizika megáll, a minták gyűlnek)',
  'Fotó renderelés', 'Sugárkövetési gyorsítóstruktúra építése…', '{samples}/{target} minta',
  'Valódi path tracing: üvegtörés és lágy árnyékok. A folyadékszintek közelítettek. Bármikor menthető — több minta, kevesebb zaj.',
  'A renderelő indítása sikertelen (WebGL2 szükséges)', 'PNG mentése'],
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
insert(types_path, [f"{indent}'{key}': string;" for key in KEYS], "'lab.sandboxPhoto'")

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
    insert(path, block, 'lab.sandboxPhoto')

print('done')
