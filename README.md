# VS Worktree

Команды VS Code для набора Git-репозиториев, которые работают вместе: одна feature-ветка получает свой worktree в каждом репозитории и общий multi-root workspace. 
Конфигурация проекта — `.vscode/project-worktree.json`.

## Установка и запуск

Установить `vs-worktree-0.1.4.vsix` через **Extensions → … → Install from VSIX**. 
Открыть папку проекта, содержащую `.vscode/project-worktree.json`. 
В Activity Bar слева открыть **VS Worktree**: в sidebar доступны **New worktrees**, **Reset repositories**, **Remove feature worktrees** и **Show Output**.
Те же операции доступны через `Ctrl+Shift+P`:

- **WT: Reset** — заново клонировать original/bare и создать main-worktree всех репозиториев.
- **WT: New** — ввести ветку, например `feat/SHOP-42`, и создать worktree каждого репозитория.
- **WT: Done** — выбрать feature-ветку и удалить её worktree. Git-ветки сохраняются.

После Reset/New можно открыть созданный workspace в новом окне. Журнал команд и ошибок — **Output → VS Worktree**; его также открывает **Show Output** в sidebar или кнопка в заголовке панели.
При завершении журнал явно пишет **Completed** с проектом и веткой, а при предупреждениях подготовки — **Completed with … warning(s)**.
Для Reset/New ниже выводится путь workspace, для Done — подтверждение удаления worktree с сохранением Git-веток.
В sidebar виден текущий или итоговый статус; во время операции кнопки изменения недоступны.
В multi-root workspace расширение находит исходный конфиг; если открыто несколько проектов, предлагает выбор.

## Конфиг

Конфиг хранится в `.vscode/project-worktree.json`.

Пример для интернет-магазина из backend и frontend:

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
      "main_branch_name": "develop"
    },
    {
      "name": "[fe]web",
      "url": "git@github.com:example/shop-web.git",
      "main_branch_name": "main"
    },
  ]
}
```

Путь репозитория берётся из URL. Для `[be]api` получатся:

```text
worktrees/.original/example/shop-api/
worktrees/.bare/example/shop-api/
worktrees/main/example/shop-api/
worktrees/feat/SHOP-42/example/shop-api/
```

В `.original`, `main` и каждой feature-папке появляется `workspace.code-workspace` с именами папок из `repositories[].name`.
Ветка New стартует от **локальной** `main_branch_name` в bare; существующая свободная ветка используется повторно.
New не выполняет fetch/merge. Reset обновляет базу повторным клонированием. Original использует default branch сервера, main-worktree — `main_branch_name`.

## Подготовка и удаление

После клонирования/создания worktree  при наличии манифестов запускаются `go mod vendor` и `npm install`.
Ошибки установки показываются в журнале и уведомлении, созданные worktree остаются доступны.

Reset и Done требуют подтверждение. До первого удаления проверяются все репозитории: изменения и untracked-файлы останавливают операцию.
Ветки с незапушенными коммитами нужно запушить или удалить вручную.
Игнорируемые файлы, включая установленные зависимости, удаляются вместе с original/main при Reset.
Done использует обычный `git worktree remove`, без `--force`;
если feature-папку удалили вручную, Done снимает оставшуюся регистрацию worktree.
