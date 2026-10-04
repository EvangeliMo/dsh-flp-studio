# PyFLP Python 3.12 兼容补丁

PyFLP（`pyflp`，截至 2.2.1）在 Python 3.12 下无法解析 `.flp`：

```
TypeError: <enum 'EventEnum'> has no members; specify `names=()` if you meant to create a new, empty, enum
```

根因：[Python 3.12 变更了 Enum 行为](https://github.com/python/cpython/pull/109122)——
空枚举（无成员）必须显式 `names=()` 才能创建/实例化。PyFLP 的 `EventEnum` 是
设计上的空基枚举（真实成员在各子类），3.12 下实例化即报错。
参考 [PyFLP issue #183](https://github.com/demberto/PyFLP/issues/183)。

## 补丁

编辑 `site-packages/pyflp/_events.py`，在 `_EventEnumMeta` 中增加 `__call__`
路由（整数查找走 `_missing_`，创建伪成员）：

```python
class _EventEnumMeta(enum.EnumMeta):
    # pylint: disable=bad-mcs-method-argument
    def __contains__(self, obj: object) -> bool:
        return obj in tuple(self)  # type: ignore

    def __call__(cls, value, *args, **kwargs):
        # Python 3.12 routes Enum(int_value) through the functional API when
        # the enum has no members, raising "has no members". Route integer
        # lookups through _missing_ which creates pseudo-members on demand.
        if isinstance(value, int):
            member = cls._missing_(value)
            if member is not None:
                return member
        return super().__call__(value, *args, **kwargs)
```

应用后验证：

```powershell
python -c "import pyflp; p=pyflp.parse(r'C:\path\to\project.flp'); print(len(p.channels))"
```

## 备注

- 该补丁只改本机安装的 PyFLP；重装 `pyflp` 后需重新应用。
- 若上游修复（`EventEnum` 支持 3.12），可移除本补丁。
