const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');
const express = require('express');
const mysql = require('mysql2');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

const RESULT_DIR = path.join(__dirname, 'result');

function ensureResultDir() {
  if (!fs.existsSync(RESULT_DIR)) {
    fs.mkdirSync(RESULT_DIR, { recursive: true });
  }
}

ensureResultDir();

const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;

const connection1 = mysql.createConnection({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

app.post('/bible', (req, res) => {
    const { days } = req.body;
    const parsedDays = Number(days);

    if (!Number.isInteger(parsedDays) || parsedDays <= 0) {
      return res.status(400).json({ error: '유효한 통독 일수를 입력하세요.' });
    }

    connection1.query(
      `
        SELECT b.idx, b.long_label, b.chapter, b.book, b.countOfChapter
        FROM bible2 b
        INNER JOIN (
          SELECT chapter, book, MIN(idx) AS min_idx
          FROM bible2
          GROUP BY chapter, book
        ) sub
        ON b.chapter = sub.chapter AND b.book = sub.book AND b.idx = sub.min_idx
        ORDER BY b.idx
      `,
      (error, results) => {
        if (error) {
          console.error('데이터베이스 조회 오류:', error);
          return res.status(500).json({ error: '데이터베이스 조회 중 오류가 발생했습니다.' });
        }

        // 모든 글자 수
        const allCount = results.reduce((sum, obj) => sum + obj.countOfChapter, 0);

        // 모든 글자 수를 일수로 나누어 평균 글자 수를 구함
        const countAvg = Math.floor(allCount / parsedDays);

        let bibleList;
        try {
          bibleList = divideBibleByDays(results, countAvg, 0.01, parsedDays);
        } catch (divideError) {
          console.error('통독 데이터 분할 오류:', divideError);
          return res.status(500).json({ error: '통독 데이터를 분할하지 못했습니다.' });
        }

        ensureResultDir();
        const outputFilename = `성경통독표(${parsedDays}일).csv`;
        const filePath = path.join(RESULT_DIR, outputFilename);

        const csvWriter = createObjectCsvWriter({
          path: filePath,
          header: [
            { id: 'date', title: '날짜' },
            { id: 'startLabel', title: '성경(시작)' },
            { id: 'startChapter', title: '장(시작)' },
            { id: 'endLabel', title: '성경(끝)' },
            { id: 'endChapter', title: '장(끝)' },
            { id: 'addSum', title: '글 수' }
          ]
        });

        const records = bibleList.map((item, date) => ({
          date: date + 1,
          startLabel: item.startChapter.long_label,
          startChapter: item.startChapter.chapter,
          endLabel: item.endChapter.long_label,
          endChapter: item.endChapter.chapter,
          addSum: item.endChapter.addSum
        }));

        csvWriter
          .writeRecords(records)
          .then(() => {
            console.log('CSV 파일이 성공적으로 작성되었습니다.');
            res.download(filePath, outputFilename, err => {
              if (err) {
                console.error('파일 다운로드 오류:', err);
                res.status(500).json({ error: '파일 다운로드 중 오류가 발생했습니다.' });
              }
            });
          })
          .catch(err => {
            console.error('CSV 작성 오류:', err);
            res.status(500).json({ error: 'CSV 작성 중 오류가 발생했습니다.' });
          });
      }
    );
  });


/**
 * results - 성경 데이터
 * countAvg - 평균 글자 수
 * range - 글자 수 범위 초기값 0.01
 * days - 통독 일수
 */
function buildBibleChunks(results, countAvg, range) {
  const bibleList = [];

  // 최소 글자 수
  const min = Math.floor(countAvg - countAvg * range);
  console.log('min: ', min);
  let addSum = 0;

  let chpterObj = {
    startChapter: { idx: 0, long_label: '', chapter: 0 },
    endChapter: { idx: 0, long_label: '', chapter: 0 }
  };

  for (let i = 0; i < results.length; i++) {
    const obj = results[i];

    if (addSum === 0) {
      chpterObj.startChapter = {
        idx: obj.idx,
        long_label: obj.long_label,
        chapter: obj.chapter,
        addSum
      };
    }

    addSum += obj.countOfChapter;

    if (addSum > min) {
      chpterObj.endChapter = {
        idx: obj.idx,
        long_label: obj.long_label,
        chapter: obj.chapter,
        addSum
      };

      bibleList.push(chpterObj);
      addSum = 0;
      chpterObj = {
        startChapter: { idx: 0, long_label: '', chapter: 0 },
        endChapter: { idx: 0, long_label: '', chapter: 0 }
      };
    }
  }

  // 남은 장을 마지막에 추가
  if (addSum > 0) {
    chpterObj.endChapter = {
      idx: results[results.length - 1].idx,
      long_label: results[results.length - 1].long_label,
      chapter: results[results.length - 1].chapter,
      addSum
    };
    bibleList.push(chpterObj);
  }

  console.log('bibleList.length: ', bibleList.length);
  return bibleList;
}

function divideBibleByDays(results, countAvg, range, days, options = {}) {
  const { tolerance = 0, maxIterations = 5000, step = 0.001 } = options;
  let currentRange = Math.max(step, range);
  let bestPlan = null;
  let bestDiff = Infinity;

  for (let i = 0; i < maxIterations; i++) {
    const bibleList = buildBibleChunks(results, countAvg, currentRange);
    const diff = Math.abs(bibleList.length - days);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestPlan = bibleList;
    }

    if (diff <= tolerance) {
      return bibleList;
    }

    if (bibleList.length < days) {
      currentRange += step;
    } else {
      currentRange = Math.max(step, currentRange - step);
    }
  }

  if (!bestPlan) {
    throw new Error('성경 통독 데이터를 분할할 수 없습니다.');
  }

  return bestPlan;
}
