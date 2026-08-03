# Gandoni Launcher

Лаунчер Minecraft на Tauri 2 (Rust) + React + TypeScript.

Игрок выбирает режим — лаунчер сам скачивает нужную версию игры, лоадер, библиотеки,
ассеты, Java и все моды сборки, следит за обновлениями (докачивает новое, удаляет
убранное) и запускает игру.

## Что умеет

- **Режимы** — список сборок берётся из вашего `manifest.json` (URL или локальный файл).
- **Версии и лоадеры** — ванилла, Fabric, Quilt, Forge, NeoForge. Forge/NeoForge ставятся
  по-настоящему: лаунчер прогоняет процессоры установщика, как официальный инсталлятор.
- **Java** — нужная версия скачивается с серверов Mojang автоматически; свой путь тоже можно указать.
- **Обновления** — сравнение по SHA-1: новые файлы качаются, удалённые из сборки стираются,
  чужие файлы игрока не трогаются.
- **Аккаунты** — оффлайн по нику и вход по лицензии Microsoft (device code flow).
- **Запуск** — игра стартует из лаунчера, её вывод виден во встроенной консоли,
  есть авто-подключение к серверу режима.
- **Кнопка в меню игры** — для Fabric/Quilt-режимов с сервером лаунчер подкидывает
  клиентский мод [`gandoni-quickjoin`](mod/), который добавляет в главное меню
  Minecraft кнопку мгновенного захода на сервер режима. Мод и его конфиг
  проставляются автоматически; нужен только Fabric API в сборке. Подробности —
  в [`mod/README.md`](mod/README.md).

## Разработка

```bash
npm install
npm start          # tauri dev — окно лаунчера + hot reload фронтенда
npm run bundle     # сборка приложения (.app / .msi / .deb)
```

Требования: Node 18+, Rust 1.88+ (`rustup update stable`), системные зависимости Tauri.

Полезное:

```bash
npm run build      # только фронтенд
cd src-tauri && cargo test
node tools/make-icon.mjs && npx tauri icon src-tauri/icon-source.png   # перегенерировать иконки
```

Есть три тяжёлых теста, помеченных `#[ignore]` — они ходят в сеть и проверяют настоящий сценарий:

```bash
cd src-tauri
cargo test --lib -- --ignored resolves_real   # разбор version.json Mojang и профиля Fabric
cargo test --lib -- --ignored installs_vanilla # полная установка версии (~800 МБ) и сборка команды
cargo test --lib -- --ignored actually_launches # запускает настоящую игру на несколько секунд
```

Папку для этих тестов можно задать переменной `GANDONI_TEST_ROOT`.

## Релизы и автообновление

Лаунчер обновляет сам себя: при запуске он ходит за `latest.json` последнего релиза
на GitHub, сравнивает версии и, если вышла новая, показывает плашку «Обновить» —
скачивает, проверяет подпись, ставит и перезапускается.

### Как выпустить версию

```bash
npm run bump 0.2.0                      # версия в package.json и Cargo.toml
git commit -am "версия 0.2.0"
git tag v0.2.0 && git push origin main --tags
```

Дальше всё делает [`.github/workflows/release.yml`](.github/workflows/release.yml):
собирает macOS (universal), Windows и Linux, подписывает обновлялку, создаёт релиз
черновиком и публикует его, когда готовы все три платформы. Через несколько минут
новая версия видна на странице загрузки, а у установленных лаунчеров всплывает плашка.

Версия задаётся **только** в `package.json` — `tauri.conf.json` читает её оттуда
(`"version": "../package.json"`), поэтому расхождений быть не может. Тег обязан
совпадать с этой версией, иначе workflow остановится на первом же шаге.

### Что нужно настроить один раз

1. **Репозиторий.** Замените `GANDONI-OWNER/gandoni-launcher` в
   `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`) на свой `owner/repo`.
   Репозиторий должен быть публичным — иначе ссылки на релизы требуют токена.
2. **Секреты репозитория** (Settings → Secrets and variables → Actions):

   | Секрет | Откуда взять |
   | --- | --- |
   | `TAURI_SIGNING_PRIVATE_KEY` | содержимое `~/.tauri/gandoni-launcher.key` целиком |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | пароль, заданный при генерации ключа |
   | `GANDONI_MS_CLIENT_ID` | Client ID приложения Azure (см. ниже) |

Ключи подписи созданы командой `npm run tauri signer generate`. Публичный ключ уже
лежит в `tauri.conf.json`. **Приватный ключ и пароль храните бережно**: потеряете —
и обновиться смогут только те, кто скачает новый установщик вручную.

### Подписи ОС

Сборки не подписаны сертификатами Apple и Microsoft, поэтому при первом запуске
macOS скажет «программу нельзя открыть» (лечится «правый клик → Открыть»), а
Windows покажет предупреждение SmartScreen. На само автообновление это не влияет —
оно проверяется отдельной подписью Tauri. Когда появятся сертификаты, notarization
и подпись Windows добавляются в тот же workflow без переделок.

### Страница загрузки

`https://<ваш-домен>/download` — раздаётся тем же сервером, что и манифест
(см. [`server/README.md`](server/README.md)). Страница сама подтягивает последний
релиз с GitHub, определяет систему посетителя и предлагает нужный файл, так что
после выпуска новой версии её не надо трогать.

## Манифест режимов

Лаунчер ходит за одним JSON-файлом. Адрес задаётся в настройках
(по умолчанию — константа `DEFAULT_MANIFEST_URL` в `src-tauri/src/config.rs`).
Пример: [`server-example/manifest.json`](server-example/manifest.json).

```json
{
  "schema": 1,
  "modes": [
    {
      "id": "survival",
      "name": "Выживание",
      "description": "Классическое выживание",
      "version": "1.4.0",
      "icon": "https://cdn.example.com/survival/icon.png",
      "banner": "https://cdn.example.com/survival/banner.jpg",
      "minecraft": "1.20.1",
      "loader": { "type": "fabric", "version": "latest" },
      "java": { "major": 17 },
      "memory": { "min": 1024, "max": 4096 },
      "server": { "host": "mc.example.com", "port": 25565 },
      "syncPaths": ["mods", "config"],
      "keep": ["config/keybinds.txt"],
      "jvmArgs": "-XX:+UseZGC",
      "files": [
        {
          "path": "mods/sodium.jar",
          "url": "https://cdn.example.com/survival/files/mods/sodium.jar",
          "sha1": "…",
          "size": 1048576,
          "optional": false
        }
      ]
    }
  ]
}
```

Поля режима:

| Поле | Обязательное | Что делает |
| --- | --- | --- |
| `id` | да | Идентификатор и имя папки сборки |
| `minecraft` | да | Версия игры, например `1.20.1` |
| `loader.type` | нет | `vanilla` (по умолчанию), `fabric`, `quilt`, `forge`, `neoforge` |
| `loader.version` | нет | Версия лоадера; `latest` или пусто — возьмём свежую |
| `java.major` | нет | Требуемая мажорная версия Java (иначе берётся из version.json Mojang) |
| `memory.min` / `memory.max` | нет | Память в МБ; перекрывает настройку лаунчера |
| `server` | нет | Куда подключаться при запуске (если включено в настройках) |
| `files[]` | нет | Список файлов сборки: `path` относительно папки игры, `url`, `sha1`, `size` |
| `files[].optional` | нет | Ставится один раз; если игрок удалил — лаунчер не возвращает |
| `syncPaths` | нет | Папки под контролем лаунчера (по умолчанию `["mods"]`) |
| `keep` | нет | Что не удалять при синхронизации, поддерживается `*` |

### Как обновлять сборку

`sha1` — источник истины. Если файл изменился, поменяйте хэш в манифесте, и лаунчер
перекачает его. Если файл убрали из манифеста, лаунчер удалит его с диска — но только
если сам его когда-то поставил и он лежит внутри `syncPaths`. Моды, которые игрок
добавил вручную, остаются на месте.

### Генерация манифеста

Разложите файлы так:

```
modes/
  survival/
    mode.json      # метаданные без files
    files/
      mods/sodium.jar
      config/sodium-options.json
```

и выполните:

```bash
node tools/build-manifest.mjs \
  --src ./modes \
  --base https://cdn.example.com/modes \
  --out ./manifest.json
```

Скрипт посчитает `sha1` и `size` для каждого файла и соберёт готовый манифест.
Файлы и манифест можно раздавать любым статическим хостингом (nginx, S3, GitHub Pages).

## Вход через Microsoft

Для оффлайн-аккаунтов ничего настраивать не нужно. Для лицензии нужен один Client ID
приложения Azure — на весь лаунчер, для всех пользователей.

1. Azure Portal → App registrations → New registration.
2. **Supported account types**: «Personal Microsoft accounts only».
3. **Authentication** → Advanced → **Allow public client flows** → **Yes**.
4. Скопируйте **Application (client) ID**.

Client ID берётся в таком порядке приоритета:

1. значение из настроек лаунчера (если пользователь вписал своё);
2. переменная окружения `GANDONI_MS_CLIENT_ID` при запуске (для отладки);
3. значение, **зашитое в бинарь на сборке** — один ID на всех.

Чтобы зашить ID для всех пользователей, задайте переменную при сборке:

```bash
GANDONI_MS_CLIENT_ID=<your-client-id> npm run bundle   # релизная сборка
GANDONI_MS_CLIENT_ID=<your-client-id> npm start         # dev-запуск
```

Тогда поле в настройках можно оставить пустым — Microsoft-вход работает из коробки.
Client ID не секрет (client secret не нужен), его можно спокойно зашивать в дистрибутив.

Вход идёт по device code: лаунчер показывает код и открывает страницу Microsoft,
токен обновляется автоматически перед каждым запуском.

## Куда всё ставится

```
<папка данных приложения>/game/
  assets/            # ассеты, общие для всех режимов
  libraries/
  versions/<id>/     # version.json, client.jar, natives/
  java/              # среды выполнения от Mojang
  cache/             # установщики Forge/NeoForge
  instances/<mode>/  # игровая папка режима: mods, config, saves
    .gandoni-state.json   # что поставил лаунчер — нужно для корректного удаления
```

Папку можно сменить в настройках.

## Структура кода

```
src/                     React-интерфейс
  api.ts                 типы и обёртки над командами Tauri
  components/            Sidebar, ModeView, Console, диалоги
src-tauri/src/
  lib.rs                 состояние приложения и команды
  manifest.rs            формат манифеста режимов
  installer.rs           оркестрация установки
  mojang.rs              version.json, библиотеки, ассеты, нативы
  fabric.rs forge.rs     лоадеры
  java.rs                поиск и загрузка Java
  sync.rs                план обновления: что скачать, что удалить
  launch.rs              сборка команды java и запуск игры
  auth.rs                Microsoft device code flow
  download.rs            параллельная загрузка с проверкой хэшей
```
