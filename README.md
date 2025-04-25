# humblebundle-ebook-downloader

An easy way to download ebooks from your humblebundle account

## Installation

To run the tool, you can either install NodeJS and use npm to install it, or install Docker and run it as a docker container.

### Docker
To run the tool via Docker, run:

```shell
 docker build -t hb-downloader .

 docker run --rm -it -v "$PWD/config.json:/usr/src/app/config.json" -v "$PWD/download:/download" hb-downloader --config ./config.json
```
This will download the books to the directory in your `./config.json` under `downloadFolder`. (I used `/download/download`)
You should also put your auth-token in the `source` of that config.json

## Usage

```shell
$ humblebundle-ebook-downloader --help

  Usage: humblebundle-ebook-downloader [options]

  Options:

    -V, --version                              output the version number
    -d, --download-folder <downloader_folder>  Download folder (default: download)
    -l, --download-limit <download_limit>      Parallel download limit (default: 1)
    -f, --format <format>                      What format to download the ebook in (all, cbz, epub, mobi, pdf, pdf_hd) (default: epub)
    --auth-token <auth-token>                  Optional: If you want to run headless, you can specify your authentication cookie from your browser (_simpleauth_sess)
    -a, --all                                  Download all bundles
    --debug                                    Enable debug logging
    -h, --help                                 output usage information
```

## Contributors
- [J. Longman](https://github.com/jlongman)
- [Johannes Löthberg](https://github.com/kyrias)
- [jaycuse](https://github.com/jaycuse)
- [localpcguy](https://github.com/localpcguy)
- [Trevor Vance](https://github.com/Trevo525)

## License
See [LICENSE.md](LICENSE.md)