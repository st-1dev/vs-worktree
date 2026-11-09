# VS Worktree

Команды VS Code для набора Git-репозиториев, которые работают вместе: одна
feature-ветка получает свой worktree в каждом репозитории и общий multi-root
workspace. 

Конфигурация проекта — `.vscode/project-worktree.json`.

## Установка и запуск

Установить `vs-worktree-*.vsix` через **Extensions → … → Install from
VSIX**. Открыть папку проекта, содержащую `.vscode/project-worktree.json`. 
В Activity Bar слева открыть **VS Worktree**: в sidebar доступны **New
worktrees**, **Update repositories**, **Remove feature worktrees** и **Show
Output**. Для первого клонирования или полного пересоздания раскройте
**Maintenance → Reset repositories**; для обычного обновления используйте
**Update repositories**. Те же операции доступны через `Ctrl+Shift+P`:

- **WT: Reset** — заново клонировать original/bare и создать main-worktree всех
  репозиториев.
- **WT: Update** — получить изменения с origin для original/bare и обновить
  original/main через fast-forward.
- **WT: New** — ввести ветку, например `feat/SHOP-42`, и создать worktree
  каждого репозитория.
- **WT: Done** — выбрать feature-ветку и удалить её worktree. Git-ветки
  сохраняются.

После Reset/New можно открыть созданный workspace в новом окне. Журнал команд и
ошибок — **Output → VS Worktree**; его также открывает **Show Output** в sidebar
или кнопка в заголовке панели. При завершении журнал явно пишет **Completed** с
проектом и веткой, а при предупреждениях подготовки — **Completed with …
warning(s)**. Для Reset/New ниже выводится путь workspace, для Done —
подтверждение удаления worktree с сохранением Git-веток, для Update —
подтверждение обновления original/bare/main. Update работает в текущем окне. В
sidebar виден текущий или итоговый статус; во время операции кнопки изменения
недоступны. В multi-root workspace расширение находит исходный конфиг; если
открыто несколько проектов, предлагает выбор.

После выбора проекта панель показывает его имя и число репозиториев. Отдельная
строка статуса с иконкой открывает журнал; её подсказка содержит полный
результат, ветку или причину ошибки. Во время ожидания/выполнения у действий
видны подписи **running… / busy**, журнал остаётся доступным. Отмена выбора
сохраняет предыдущий результат. В Restricted Mode панель объясняет необходимость
доверия workspace. Панель использует нативные элементы, клавиатурную навигацию,
иконки и цвета текущей темы VS Code.

## Конфиг

Начиная с 0.1.3 используется `.vscode/project-worktree.json`. В существующих
проектах переименуйте `.vscode/project.json` в `.vscode/project-worktree.json`;
содержимое менять не нужно.

Пути считаются от папки проекта, содержащей `.vscode`, а не от самой `.vscode`.
Комментарии и завершающие запятые поддерживаются. Пример для интернет-магазина
из backend и frontend:

```jsonc
{
  "project": "Shop",
  "workdir": "worktrees",
  "bare_repositories_dir_path": "worktrees/.bare",
  "original_repositories_dir_path": "worktrees/.original",
  "repositories": [
    {
      "name": "[be]api",
      "url": "git@github.com:example/shop-api.git",
      "main_branch_name": "develop",
    },
    {
      "name": "[fe]web",
      "url": "git@github.com:example/shop-web.git",
      "main_branch_name": "main",
    },
  ],
}
```

Путь репозитория берётся из URL. Для `[be]api` получатся:

```text
worktrees/.original/example/shop-api/
worktrees/.bare/example/shop-api/
worktrees/main/example/shop-api/
worktrees/feat/SHOP-42/example/shop-api/
```

В `.original`, `main` и каждой feature-папке появляется
`workspace.code-workspace` с именами папок из `repositories[].name`. Ветка New
стартует от **локальной** `main_branch_name` в bare; существующая свободная
ветка используется повторно. New не выполняет fetch/merge. Для обновления базы
используйте Update; Reset обновляет её повторным клонированием. Original при
Reset использует default branch сервера, main-worktree — `main_branch_name`.

## Обновление кода

**Update repositories / WT: Update** выполняет fetch с origin в `.original` и
bare с обновлением remote-tracking веток и удалением устаревших remote-ссылок.
Затем текущая ветка `.original` (после Reset — default branch сервера)
обновляется из одноимённой ветки origin, а main-worktree — из
`origin/main_branch_name`. Ветка main в bare обновляется вместе с worktree.
Локальные feature-ветки и их worktree сохраняются; теги не синхронизируются.

Перед обновлением проверяются все original/main: несохранённые редакторы,
tracked/untracked-изменения, detached HEAD, locked main, незавершённые
Git-операции и разошедшаяся история блокируют команду. Ветки, опережающие
origin, сохраняют локальные коммиты; принудительного сброса и автоматического
stash нет. Игнорируемый файл, который стал tracked на сервере, Git не
перезаписывает. При отсутствии исходных репозиториев нужно сначала выполнить
Reset. Feature-worktree могут содержать локальные изменения и не блокируют
Update.

После обновления кода запускается обычная подготовка зависимостей для
original/main. Fetch может обновить remote-ссылки даже при последующем отказе
проверки. При ошибке во время fast-forward или подготовки уже выполненные шаги
сохраняются; устраните причину и повторите Update. Переклонирования, удаления
каталогов и автоматического отката нет.

## Подготовка и удаление

После клонирования/создания worktree восстанавливается tracked `deploy`, затем
при наличии манифестов запускаются `go mod vendor` и `npm install`. Ошибки
установки показываются в журнале и уведомлении, созданные worktree остаются
доступны. Новые неотслеживаемые файлы, созданные подготовкой (например
`vendor/`, `node_modules/`, `package-lock.json`), добавляются в `info/exclude`
репозитория, чтобы не блокировать Done и Reset. Если подготовка изменила
tracked-файлы, расширение предупреждает: такие изменения нужно закоммитить или
откатить.

Reset и Done требуют подтверждение. До первого удаления проверяются все
репозитории: изменения и untracked-файлы останавливают операцию. Reset также
блокируется при активных/locked feature-worktree, stash, локальных тегах и
коммитах, которых нет на origin. Локальная ветка, все коммиты которой уже есть в
какой-либо ветке origin (например, после merge и удаления ветки на сервере),
Reset не блокирует; её имя будет удалено при повторном клонировании, это
отмечается в журнале. Ветки с незапушенными коммитами нужно запушить или удалить
вручную. Игнорируемые файлы, включая установленные зависимости, удаляются вместе
с original/main при Reset. Done использует обычный `git worktree remove`, без
`--force`; если feature-папку удалили вручную, Done снимает оставшуюся
регистрацию worktree.

Пути внутри проекта не могут проходить через symlink или пересекать
main/bare/original. Одновременно выполняется одна операция на проект. После
аварийного завершения процесса проверьте другие окна VS Code и удалите
`.vscode/vs-worktree.lock` вручную, если операций уже нет.

При Git-ошибке выполнение останавливается с сохранением журнала и уже
выполненных шагов. Done умеет убрать частично созданную feature-группу.
Автоматического отката нет; перед повтором Reset нужно устранить указанную в
журнале проблему. Посторонние файлы в feature-папке Done сохраняет.

Нужны Git в PATH и настроенный доступ к Git-серверу; для соответствующих
репозиториев — Go/npm. SSH-ключи и credential helper используются из окружения
VS Code; интерактивный ввод не поддерживается: stdin команд закрыт. На Remote
SSH команды выполняются на удалённой машине. Расширение требует доверенный
workspace, согласно
[Workspace Trust API](https://code.visualstudio.com/api/extension-guides/workspace-trust).

JSON schema подключается ко всем файлам `.vscode/project-worktree.json`; в
проектах, где файл с таким именем используется для другого, VS Code может
показывать лишние предупреждения схемы.
