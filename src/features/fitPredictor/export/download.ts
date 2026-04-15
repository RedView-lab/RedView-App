import type ExcelJS from 'exceljs';

/**
 * Write the workbook to a .xlsx buffer, create a Blob and trigger a
 * browser download via a temporary anchor element.
 */
export async function downloadExcel(
  workbook: ExcelJS.Workbook,
  filename: string,
): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Cleanup
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
