"""PyInstaller entrypoint (also required by multiprocessing-based dependencies)."""
import multiprocessing

if __name__ == '__main__':
    multiprocessing.freeze_support()
    from reader_next_api.desktop import main
    raise SystemExit(main())
