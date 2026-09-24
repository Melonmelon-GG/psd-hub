/**
 * fieldRules 表单校验测试（契约 **v2.0** §3.6）：
 * 逐条断言中文错误信息 —— 标题 1..120、说明 ≤5000、作者 ≤60、标签 ≤12 个每项 ≤24 字符，
 * 以及 v2.0 新增的 image（仅 PNG + 魔数）、netdiskUrl（http(s) + 长度）、
 * extractCode ≤16、sourceFileName ≤200、sourceNote ≤200。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTHOR_MAX,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_NETDISK_URL_MAX,
  DESCRIPTION_MAX,
  PNG_MAGIC_BYTES,
  SOURCE_FILE_NAME_MAX,
  SOURCE_NOTE_MAX,
  TAG_MAX_LENGTH,
  TAGS_MAX_COUNT,
  TITLE_MAX,
  fileExtension,
  formatBytes,
  hasErrors,
  isPngMagic,
  parseTags,
  readFileHeader,
  validateAuthor,
  validateDescription,
  validateExtractCode,
  validateImageFile,
  validateNetdiskUrl,
  validateSourceFileName,
  validateSourceNote,
  validateTags,
  validateTitle,
  validateUploadForm,
  validateUploadFormWithHeader,
} from '../src/upload/fieldRules.ts';

/** 合法的 PNG 文件头（8 字节） */
const PNG_HEADER = Uint8Array.from(PNG_MAGIC_BYTES);
/** 合法的 JPEG 文件头（FF D8 FF E0 00 10 4A 46） */
const JPEG_HEADER = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/** 造一个只有 slice() 的"文件"，用于测试文件头读取 */
function fakeFile(bytes: Uint8Array | null): { slice: (start?: number, end?: number) => Blob } {
  return {
    slice: () => ({
      arrayBuffer: async () => {
        if (!bytes) throw new Error('read failed');
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    }) as unknown as Blob,
  };
}

/* ------------------------------ 标题 ------------------------------ */

test('标题为空时报「标题不能为空」', () => {
  const result = validateTitle('');
  assert.equal(result.ok, false);
  assert.equal(result.message, '标题不能为空');
});

test('标题仅含空白字符同样视为空', () => {
  assert.equal(validateTitle('    ').ok, false);
  assert.equal(validateTitle('\n\t ').message, '标题不能为空');
});

test('标题恰好 120 字符通过，121 字符报错并给出当前长度', () => {
  const ok = validateTitle('a'.repeat(TITLE_MAX));
  assert.equal(ok.ok, true);

  const tooLong = validateTitle('a'.repeat(TITLE_MAX + 1));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.message, `标题最多 ${TITLE_MAX} 个字符，当前 ${TITLE_MAX + 1} 个`);
});

test('中文标题按字符计数', () => {
  assert.equal(validateTitle('深色风格 App 首页 UI 稿').ok, true);
  const long = validateTitle('工'.repeat(121));
  assert.equal(long.ok, false);
  assert.match(long.message ?? '', /最多 120 个字符/);
});

/* ------------------------------ 说明 / 作者 / 标签 ------------------------------ */

test('说明可以为空，也可到 5000 字符，超出报错', () => {
  assert.equal(validateDescription('').ok, true);
  assert.equal(validateDescription('说'.repeat(DESCRIPTION_MAX)).ok, true);

  const result = validateDescription('说'.repeat(DESCRIPTION_MAX + 1));
  assert.equal(result.ok, false);
  assert.equal(result.message, `说明最多 ${DESCRIPTION_MAX} 个字符，当前 ${DESCRIPTION_MAX + 1} 个`);
});

test('作者可以为空（后端会写「匿名作者」），61 字符报错', () => {
  assert.equal(validateAuthor('').ok, true);
  assert.equal(validateAuthor('   ').ok, true);
  assert.equal(validateAuthor('名'.repeat(AUTHOR_MAX)).ok, true);

  const result = validateAuthor('名'.repeat(AUTHOR_MAX + 1));
  assert.equal(result.ok, false);
  assert.equal(result.message, `作者最多 ${AUTHOR_MAX} 个字符，当前 ${AUTHOR_MAX + 1} 个`);
});

test('标签数量上限 12 个，单项上限 24 字符', () => {
  assert.equal(validateTags(Array.from({ length: TAGS_MAX_COUNT }, (_, i) => `标签${i}`)).ok, true);

  const tooMany = validateTags(Array.from({ length: TAGS_MAX_COUNT + 1 }, (_, i) => `标签${i}`));
  assert.equal(tooMany.message, `标签最多 ${TAGS_MAX_COUNT} 个，当前 ${TAGS_MAX_COUNT + 1} 个`);

  const tooLong = validateTags(['正常', 'b'.repeat(TAG_MAX_LENGTH + 1)]);
  assert.equal(
    tooLong.message,
    `单个标签最多 ${TAG_MAX_LENGTH} 个字符：「${'b'.repeat(TAG_MAX_LENGTH + 1)}」为 ${TAG_MAX_LENGTH + 1} 个`,
  );
});

test('parseTags 支持中英文逗号分隔、去重（大小写不敏感）并保留顺序', () => {
  assert.deepEqual(parseTags('UI, 科幻, 深色'), ['UI', '科幻', '深色']);
  assert.deepEqual(parseTags('UI，科幻，深色'), ['UI', '科幻', '深色']);
  assert.deepEqual(parseTags(' UI ,, 科幻 ,'), ['UI', '科幻']);
  assert.deepEqual(parseTags('  ,  , '), []);
  assert.deepEqual(parseTags('UI, ui, Ui'), ['UI']);
  assert.deepEqual(parseTags(['扁平化', '扁平化', '插画']), ['扁平化', '插画']);
});

/* ------------------------------ PNG 展示图 ------------------------------ */

test('fileExtension 返回带点的小写扩展名', () => {
  assert.equal(fileExtension('深色UI.PNG'), '.png');
  assert.equal(fileExtension('a.psd'), '.psd');
  assert.equal(fileExtension('无扩展名'), '');
});

test('未选择图片时提示选择', () => {
  assert.equal(validateImageFile(null).message, '请选择要上传的 PNG 图片');
  assert.equal(validateImageFile(undefined).ok, false);
});

test('仅接受 .png 扩展名（大小写不敏感）', () => {
  assert.equal(validateImageFile({ name: 'a.png', size: 100, type: 'image/png' }).ok, true);
  assert.equal(validateImageFile({ name: 'a.PNG', size: 100, type: 'image/png' }).ok, true);

  const bad = validateImageFile({ name: 'a.jpg', size: 100, type: 'image/jpeg' });
  assert.equal(bad.ok, false);
  assert.equal(bad.message, '仅支持 .png 图片，当前为「.jpg」');

  const noExt = validateImageFile({ name: 'noext', size: 100, type: '' });
  assert.equal(noExt.message, '仅支持 .png 图片，当前为「无扩展名」');
});

test('isPngMagic 只认标准 PNG 魔数 89 50 4E 47 0D 0A 1A 0A', () => {
  assert.equal(isPngMagic(PNG_HEADER), true);
  assert.equal(isPngMagic(JPEG_HEADER), false);
  assert.equal(isPngMagic(Uint8Array.from([])), false);
  assert.equal(isPngMagic(Uint8Array.from(PNG_MAGIC_BYTES.slice(0, 7))), false);
  assert.equal(isPngMagic(null), false);
  // GIF 头（47 49 46 38）不能通过
  assert.equal(isPngMagic(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00])), false);
});

test('提供文件头时，非 PNG 内容会被拒绝', () => {
  const ok = validateImageFile(
    { name: 'a.png', size: 100, type: 'image/png' },
    { header: PNG_HEADER },
  );
  assert.equal(ok.ok, true);

  const bad = validateImageFile(
    { name: 'a.png', size: 100, type: 'image/png' },
    { header: JPEG_HEADER },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.message, '这个文件的内容不是有效的 PNG 图片（文件头校验未通过）');
});

test('读不到文件头时跳过魔数校验（不误伤正常文件）', () => {
  const result = validateImageFile(
    { name: 'a.png', size: 100, type: 'image/png' },
    { header: null },
  );
  assert.equal(result.ok, true);
});

test('图片体积超过上限时展示后端给出的上限标签', () => {
  const result = validateImageFile(
    { name: 'big.png', size: DEFAULT_MAX_UPLOAD_BYTES + 1, type: 'image/png' },
    { maxBytes: DEFAULT_MAX_UPLOAD_BYTES, maxLabel: '20 MB' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.message, '图片体积超过服务端上限 20 MB');
});

test('readFileHeader 读出前 8 字节；读取失败返回 null', async () => {
  const header = await readFileHeader(fakeFile(PNG_HEADER));
  assert.ok(header instanceof Uint8Array);
  assert.equal(header.length, PNG_MAGIC_BYTES.length);
  assert.equal(isPngMagic(header), true);

  assert.equal(await readFileHeader(fakeFile(null)), null);
});

/* ------------------------------ 网盘链接 ------------------------------ */

test('网盘链接必填', () => {
  assert.equal(validateNetdiskUrl('').message, '请填写网盘分享链接');
  assert.equal(validateNetdiskUrl('   ').message, '请填写网盘分享链接');
});

test('网盘链接必须是可解析的 http(s) 地址', () => {
  assert.equal(validateNetdiskUrl('https://pan.baidu.com/s/1abcd').ok, true);
  assert.equal(validateNetdiskUrl('http://pan.quark.cn/s/xyz').ok, true);

  // 缺少协议头：new URL() 解析失败
  const noScheme = validateNetdiskUrl('pan.baidu.com/s/1abcd');
  assert.equal(noScheme.ok, false);
  assert.equal(noScheme.message, '网盘分享链接格式不正确，请粘贴带 https:// 的完整链接');

  // 协议不是 http(s)
  const ftp = validateNetdiskUrl('ftp://pan.baidu.com/s/1');
  assert.equal(ftp.ok, false);
  assert.equal(ftp.message, '网盘分享链接需以 http:// 或 https:// 开头');

  // 只有协议头没有主机名：WHATWG URL 直接抛错
  const noHost = validateNetdiskUrl('https://');
  assert.equal(noHost.ok, false);
  assert.equal(noHost.message, '网盘分享链接格式不正确，请粘贴带 https:// 的完整链接');

  // 完全不是 URL
  assert.equal(validateNetdiskUrl('随便写点什么').ok, false);
});

test('网盘链接长度上限为 500（可由配置覆盖）', () => {
  const longUrl = `https://pan.baidu.com/s/${'a'.repeat(DEFAULT_NETDISK_URL_MAX)}`;
  const result = validateNetdiskUrl(longUrl);
  assert.equal(result.ok, false);
  assert.equal(result.message, `网盘分享链接最多 ${DEFAULT_NETDISK_URL_MAX} 个字符，当前 ${longUrl.length} 个`);

  const custom = validateNetdiskUrl('https://pan.baidu.com/s/1', { maxLength: 10 });
  assert.equal(custom.ok, false);
  assert.match(custom.message ?? '', /最多 10 个字符/);
});

/* ------------------------------ 提取码 / 源文件名 / 备注 ------------------------------ */

test('提取码可以为空，上限 16 字符', () => {
  assert.equal(validateExtractCode('').ok, true);
  assert.equal(validateExtractCode('   ').ok, true);
  assert.equal(validateExtractCode('a'.repeat(16)).ok, true);

  const tooLong = validateExtractCode('a'.repeat(17));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.message, '提取码最多 16 个字符，当前 17 个');

  // trim 后再计数：前后空白不计入
  assert.equal(validateExtractCode(`  ${'a'.repeat(16)}  `).ok, true);
  assert.equal(validateExtractCode('abcd', { maxLength: 3 }).ok, false);
});

test('源文件名上限 200 字符', () => {
  assert.equal(validateSourceFileName('').ok, true);
  assert.equal(validateSourceFileName('深色UI稿.psd').ok, true);
  assert.equal(validateSourceFileName('a'.repeat(SOURCE_FILE_NAME_MAX)).ok, true);

  const tooLong = validateSourceFileName('a'.repeat(SOURCE_FILE_NAME_MAX + 1));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.message, `源文件名最多 ${SOURCE_FILE_NAME_MAX} 个字符，当前 ${SOURCE_FILE_NAME_MAX + 1} 个`);
});

test('备注上限 200 字符', () => {
  assert.equal(validateSourceNote('').ok, true);
  assert.equal(validateSourceNote('含分层源文件').ok, true);
  assert.equal(validateSourceNote('说'.repeat(SOURCE_NOTE_MAX)).ok, true);

  const tooLong = validateSourceNote('说'.repeat(SOURCE_NOTE_MAX + 1));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.message, `备注最多 ${SOURCE_NOTE_MAX} 个字符，当前 ${SOURCE_NOTE_MAX + 1} 个`);
});

/* ------------------------------ 整表校验 ------------------------------ */

test('validateUploadForm 汇总逐字段错误（v2.0 字段名）', () => {
  const errors = validateUploadForm({
    image: null,
    netdiskUrl: 'pan.baidu.com/s/1',
    title: '',
    description: 'a'.repeat(DESCRIPTION_MAX + 1),
    author: 'a'.repeat(AUTHOR_MAX + 1),
    tags: Array.from({ length: TAGS_MAX_COUNT + 1 }, (_, i) => `t${i}`),
    extractCode: 'a'.repeat(17),
    sourceFileName: 'a'.repeat(SOURCE_FILE_NAME_MAX + 1),
    sourceNote: 'a'.repeat(SOURCE_NOTE_MAX + 1),
  });

  assert.equal(errors.image, '请选择要上传的 PNG 图片');
  assert.equal(errors.netdiskUrl, '网盘分享链接格式不正确，请粘贴带 https:// 的完整链接');
  assert.equal(errors.extractCode, '提取码最多 16 个字符，当前 17 个');
  assert.match(errors.sourceFileName ?? '', /源文件名最多 200 个字符/);
  assert.match(errors.sourceNote ?? '', /备注最多 200 个字符/);
  assert.equal(errors.title, '标题不能为空');
  assert.match(errors.description ?? '', /说明最多 5000 个字符/);
  assert.match(errors.author ?? '', /作者最多 60 个字符/);
  assert.match(errors.tags ?? '', /标签最多 12 个/);
  assert.equal(hasErrors(errors), true);
});

test('validateUploadForm 合法输入返回空错误表', () => {
  const errors = validateUploadForm({
    image: { name: '深色UI稿.png', size: 1024, type: 'image/png' },
    netdiskUrl: 'https://pan.baidu.com/s/1abcd',
    title: '深色风格 App 首页 UI 稿',
    description: '这是一份说明',
    author: '张三',
    tags: ['UI', '深色'],
    extractCode: 'abcd',
    sourceFileName: '深色UI稿.psd',
    sourceNote: '含分层源文件',
  });

  assert.deepEqual(errors, {});
  assert.equal(hasErrors(errors), false);
});

test('validateUploadForm 会把体积上限与配置上限透传给各字段', () => {
  const errors = validateUploadForm({
    image: { name: 'a.png', size: 200, type: 'image/png' },
    netdiskUrl: 'https://pan.baidu.com/s/1',
    title: 'ok',
    description: '',
    author: '',
    tags: [],
    extractCode: 'abcdef',
    maxBytes: 100,
    maxLabel: '100 B',
    extractCodeMaxLength: 4,
    netdiskUrlMaxLength: 10,
  });

  assert.equal(errors.image, '图片体积超过服务端上限 100 B');
  assert.equal(errors.extractCode, '提取码最多 4 个字符，当前 6 个');
  assert.match(errors.netdiskUrl ?? '', /最多 10 个字符/);
});

test('validateUploadFormWithHeader 会读取文件头并做魔数校验', async () => {
  const base = {
    netdiskUrl: 'https://pan.baidu.com/s/1abcd',
    title: '标题',
    description: '',
    author: '',
    tags: [],
  };

  // 带 slice() 的"文件"对象：先赋给变量，避免对象字面量的多余属性检查
  const pngLike = { name: 'a.png', size: 100, type: 'image/png', slice: fakeFile(PNG_HEADER).slice };
  const jpegLike = { name: 'a.png', size: 100, type: 'image/png', slice: fakeFile(JPEG_HEADER).slice };

  const pngErrors = await validateUploadFormWithHeader({ ...base, image: pngLike });
  assert.deepEqual(pngErrors, {});

  const jpegErrors = await validateUploadFormWithHeader({ ...base, image: jpegLike });
  assert.equal(jpegErrors.image, '这个文件的内容不是有效的 PNG 图片（文件头校验未通过）');

  // 普通对象没有 slice() → 读取失败 → 跳过魔数校验，只报其余字段的问题
  const softErrors = await validateUploadFormWithHeader({
    ...base,
    image: { name: 'a.png', size: 100, type: 'image/png' },
    title: '',
  });
  assert.equal(softErrors.image, undefined);
  assert.equal(softErrors.title, '标题不能为空');
});

test('formatBytes 输出人可读体积', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(DEFAULT_MAX_UPLOAD_BYTES), '20.0 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatBytes(-1), '—');
});
