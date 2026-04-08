"""
generate_pdf.py — Gerador de Proposta Comercial VIVAI Studio
Uso: python3 generate_pdf.py '<json_data>' output.pdf
"""

import sys
import json
import base64
import os
from io import BytesIO
from datetime import datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether, PageBreak
)
from reportlab.platypus.flowables import Image as RLImage
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ── Paleta de cores ───────────────────────────────────────────────────────────
NAVY     = HexColor("#0d1f2d")
CYAN     = HexColor("#00d4ff")
MAGENTA  = HexColor("#ff2d78")
GOLD     = HexColor("#ffb800")
DARK     = HexColor("#1a1a2e")
GRAY_LT  = HexColor("#f5f5f5")
GRAY_MID = HexColor("#e0e0e0")
GRAY_TXT = HexColor("#555555")
BLACK    = HexColor("#1a1a1a")

W, H = A4  # 595.27 x 841.89 pts

# ── Estilos de parágrafo ──────────────────────────────────────────────────────
def styles():
    base = dict(fontName="Helvetica", fontSize=10, leading=14, textColor=BLACK)
    return {
        "title":    ParagraphStyle("title",    fontName="Helvetica-Bold",  fontSize=22, leading=26, textColor=NAVY,     spaceAfter=2),
        "subtitle": ParagraphStyle("subtitle", fontName="Helvetica",       fontSize=11, leading=14, textColor=GRAY_TXT, spaceAfter=0),
        "h1":       ParagraphStyle("h1",       fontName="Helvetica-Bold",  fontSize=11, leading=15, textColor=CYAN,     spaceBefore=14, spaceAfter=6),
        "body":     ParagraphStyle("body",     fontName="Helvetica",       fontSize=9.5, leading=14, textColor=BLACK,   spaceAfter=4, alignment=TA_JUSTIFY),
        "bullet":   ParagraphStyle("bullet",   fontName="Helvetica",       fontSize=9.5, leading=14, textColor=BLACK,   leftIndent=12, bulletIndent=0, spaceAfter=3),
        "small":    ParagraphStyle("small",    fontName="Helvetica",       fontSize=8.5, leading=12, textColor=GRAY_TXT),
        "bold":     ParagraphStyle("bold",     fontName="Helvetica-Bold",  fontSize=9.5, leading=14, textColor=BLACK),
        "footer":   ParagraphStyle("footer",   fontName="Helvetica",       fontSize=8,  leading=10, textColor=GRAY_TXT, alignment=TA_CENTER),
        "total":    ParagraphStyle("total",    fontName="Helvetica-Bold",  fontSize=14, leading=18, textColor=NAVY),
        "objeto":   ParagraphStyle("objeto",   fontName="Helvetica",       fontSize=9.5, leading=14, textColor=BLACK,   alignment=TA_JUSTIFY),
        "objeto_h": ParagraphStyle("objeto_h", fontName="Helvetica-Bold",  fontSize=10, leading=14, textColor=CYAN),
    }

# ── Header / Footer callbacks ─────────────────────────────────────────────────
def make_page_callbacks(logo_path, client_name):
    def header(canvas, doc):
        canvas.saveState()
        # Linha topo gradiente simulada
        canvas.setFillColor(NAVY)
        canvas.rect(0, H - 8*mm, W, 8*mm, fill=1, stroke=0)
        canvas.setFillColor(CYAN)
        canvas.rect(0, H - 8*mm, W * 0.35, 8*mm, fill=1, stroke=0)
        canvas.setFillColor(MAGENTA)
        canvas.rect(W * 0.35, H - 8*mm, W * 0.15, 8*mm, fill=1, stroke=0)
        canvas.restoreState()

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(GRAY_MID)
        canvas.rect(0, 0, W, 12*mm, fill=1, stroke=0)
        canvas.setFillColor(NAVY)
        canvas.rect(0, 11*mm, W, 1*mm, fill=1, stroke=0)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(GRAY_TXT)
        txt = f"VIVAI STUDIO  •  Proposta Comercial  •  {client_name}  •  www.studiovivai.com"
        canvas.drawCentredString(W / 2, 4*mm, txt)
        # Page number
        canvas.drawRightString(W - 15*mm, 4*mm, f"Página {doc.page}")
        canvas.restoreState()

    def on_page(canvas, doc):
        header(canvas, doc)
        footer(canvas, doc)

    return on_page

# ── Funções auxiliares ─────────────────────────────────────────────────────────
def fmt_brl(v):
    try:
        return f"R$ {float(v):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    except:
        return str(v)

def bullet_items(items, S):
    result = []
    for item in items:
        result.append(Paragraph(f"<bullet>&bull;</bullet> {item}", S["bullet"]))
    return result

# ── Gerador principal ─────────────────────────────────────────────────────────
def generate(data: dict, output_path: str, logo_path: str = None):
    S = styles()
    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=2*cm, rightMargin=2*cm,
        topMargin=2.5*cm, bottomMargin=2.5*cm,
        title=f"Proposta Comercial VIVAI — {data.get('client','')}",
        author="VIVAI Studio"
    )

    client  = data.get("client", "")
    event   = data.get("event", "")
    date    = data.get("date", "")
    location = data.get("location", "")
    cnpj    = data.get("cnpj", "")
    contact = data.get("contact", "")
    delivery = data.get("delivery", "")
    notes   = data.get("notes", "")
    total   = data.get("total", 0)
    subtotal = data.get("subtotal", 0)
    caixa   = data.get("caixa", 0)
    imposto = data.get("imposto", 0)
    transport = data.get("transport_total", 0)
    edicao  = data.get("edicao_total", 0)
    diaria_team = data.get("diaria_team", 0)
    diarias = data.get("diarias", 1)
    team_items = data.get("team_items", [])   # [{label, qty, price_unit, price_total}]
    edicao_items = data.get("edicao_items", []) # [{label, price}]
    parcelas = data.get("parcelas", [])         # [{num, valor, vencimento}]
    escopo  = data.get("escopo", [])
    entregaveis = data.get("entregaveis", [])

    on_page = make_page_callbacks(logo_path, client)

    story = []

    # ── CAPA / CABEÇALHO ──────────────────────────────────────────────────────
    header_data = [[]]
    if logo_path and os.path.exists(logo_path):
        try:
            img = RLImage(logo_path, width=3*cm, height=3*cm)
            img.hAlign = "LEFT"
            title_col = [
                Paragraph("PROPOSTA COMERCIAL", S["title"]),
                Paragraph(f"{'Produção audiovisual' if not event else event} — {client}", S["subtitle"]),
            ]
            header_data = [[img, title_col]]
        except:
            header_data = [[Paragraph("PROPOSTA COMERCIAL", S["title"])]]
    else:
        header_data = [[
            Paragraph("PROPOSTA COMERCIAL", S["title"]),
            Paragraph(f"{event} — {client}", S["subtitle"]),
        ]]

    if len(header_data[0]) == 2:
        t = Table(header_data, colWidths=[3.5*cm, None])
        t.setStyle(TableStyle([
            ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
            ("LEFTPADDING", (0,0), (-1,-1), 0),
            ("RIGHTPADDING", (0,0), (-1,-1), 0),
            ("BOTTOMPADDING", (0,0), (-1,-1), 0),
            ("TOPPADDING", (0,0), (-1,-1), 0),
        ]))
        story.append(t)
    else:
        story.append(Paragraph("PROPOSTA COMERCIAL", S["title"]))
        story.append(Paragraph(f"{event} — {client}", S["subtitle"]))

    story.append(Spacer(1, 6*mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=GRAY_MID))
    story.append(Spacer(1, 5*mm))

    # ── TABELA DE DADOS ───────────────────────────────────────────────────────
    info_rows = [
        ["Contratante", client or "—"],
    ]
    if cnpj:   info_rows.append(["CNPJ", cnpj])
    if contact: info_rows.append(["Contato responsável", contact])
    if date:   info_rows.append(["Data de captação", date])
    if delivery: info_rows.append(["Entrega final", delivery])
    info_rows.append(["Investimento total", fmt_brl(total)])

    info_table = Table(info_rows, colWidths=[5*cm, None])
    info_table.setStyle(TableStyle([
        ("FONTNAME",    (0,0), (0,-1), "Helvetica"),
        ("FONTNAME",    (1,0), (1,-1), "Helvetica"),
        ("FONTSIZE",    (0,0), (-1,-1), 9.5),
        ("TEXTCOLOR",   (0,0), (0,-1), GRAY_TXT),
        ("TEXTCOLOR",   (1,0), (1,-1), BLACK),
        ("FONTNAME",    (1,-1),(1,-1), "Helvetica-Bold"),
        ("TEXTCOLOR",   (1,-1),(1,-1), NAVY),
        ("FONTSIZE",    (1,-1),(1,-1), 11),
        ("TOPPADDING",  (0,0), (-1,-1), 5),
        ("BOTTOMPADDING",(0,0),(-1,-1), 5),
        ("LEFTPADDING", (0,0), (-1,-1), 8),
        ("GRID",        (0,0), (-1,-1), 0.5, GRAY_MID),
        ("BACKGROUND",  (0,0), (0,-1), GRAY_LT),
        ("BACKGROUND",  (0,-1),(-1,-1), HexColor("#e8f4f8")),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 5*mm))

    # ── OBJETO ────────────────────────────────────────────────────────────────
    objeto = data.get("objeto", f"Prestação de serviços audiovisuais para {event or 'produção audiovisual'} da {client}, conforme escopo e condições descritos nesta proposta.")
    obj_table = Table(
        [[Paragraph("Objeto", S["objeto_h"])],
         [Paragraph(objeto, S["objeto"])]],
        colWidths=[None]
    )
    obj_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), HexColor("#f0faff")),
        ("BOX",        (0,0), (-1,-1), 0.8, CYAN),
        ("LEFTPADDING",(0,0), (-1,-1), 10),
        ("RIGHTPADDING",(0,0),(-1,-1), 10),
        ("TOPPADDING", (0,0), (-1,-1), 8),
        ("BOTTOMPADDING",(0,0),(-1,-1), 8),
    ]))
    story.append(obj_table)
    story.append(Spacer(1, 5*mm))

    # ── 1. ESCOPO ─────────────────────────────────────────────────────────────
    story.append(Paragraph("1. ESCOPO DOS SERVIÇOS", S["h1"]))
    if escopo:
        for item in escopo:
            story.append(Paragraph(f"<bullet>&bull;</bullet> {item}", S["bullet"]))
    else:
        story.append(Paragraph(
            "Os serviços contemplam pré-produção, captação audiovisual, edição e entrega dos materiais conforme os itens abaixo.",
            S["body"]
        ))
        for t in team_items:
            story.append(Paragraph(f"<bullet>&bull;</bullet> {t['qty']}x {t['label']} — {diarias} diária{'s' if diarias > 1 else ''}", S["bullet"]))
        for e in edicao_items:
            story.append(Paragraph(f"<bullet>&bull;</bullet> Pós-produção: {e['label']}", S["bullet"]))

    story.append(Spacer(1, 3*mm))

    # ── 2. ENTREGÁVEIS ────────────────────────────────────────────────────────
    story.append(Paragraph("2. ENTREGÁVEIS", S["h1"]))
    if entregaveis:
        for item in entregaveis:
            story.append(Paragraph(f"<bullet>&bull;</bullet> {item}", S["bullet"]))
    else:
        default_ent = []
        for e in edicao_items:
            default_ent.append(f"Edição: {e['label']}")
        if not default_ent:
            default_ent = ["Material editado e finalizado conforme escopo acordado"]
        for item in default_ent:
            story.append(Paragraph(f"<bullet>&bull;</bullet> {item}", S["bullet"]))

    story.append(Spacer(1, 3*mm))

    # ── 3. INVESTIMENTO ───────────────────────────────────────────────────────
    story.append(Paragraph("3. INVESTIMENTO E CONDIÇÕES DE PAGAMENTO", S["h1"]))
    story.append(Paragraph(
        f"O valor total desta proposta é de <b>{fmt_brl(total)}</b>.",
        S["body"]
    ))
    story.append(Spacer(1, 3*mm))

    # Breakdown detalhado
    breakdown = []
    for t in team_items:
        breakdown.append([f"{t['qty']}x {t['label']} × {diarias} diária{'s' if diarias > 1 else ''}", fmt_brl(t['price_total'])])
    if transport > 0:
        breakdown.append(["Transporte + alimentação", fmt_brl(transport)])
    for e in edicao_items:
        breakdown.append([f"Edição: {e['label']}", fmt_brl(e['price'])])
    breakdown.append(["Subtotal", fmt_brl(subtotal)])
    breakdown.append(["Caixa empresa (10%)", fmt_brl(caixa)])
    breakdown.append(["NF / impostos (6%)", fmt_brl(imposto)])
    breakdown.append(["TOTAL", fmt_brl(total)])

    bt = Table(breakdown, colWidths=[None, 3.5*cm])
    bt_style = [
        ("FONTSIZE",  (0,0), (-1,-1), 9),
        ("TEXTCOLOR", (0,0), (-1,-1), GRAY_TXT),
        ("TEXTCOLOR", (1,0), (-1,-1), BLACK),
        ("TOPPADDING",(0,0), (-1,-1), 4),
        ("BOTTOMPADDING",(0,0),(-1,-1), 4),
        ("LEFTPADDING",(0,0),(-1,-1), 6),
        ("LINEBELOW", (0,-4),(-1,-4), 0.5, GRAY_MID),
        ("FONTNAME",  (0,-1),(-1,-1), "Helvetica-Bold"),
        ("FONTSIZE",  (0,-1),(-1,-1), 10.5),
        ("TEXTCOLOR", (0,-1),(-1,-1), NAVY),
        ("BACKGROUND",(0,-1),(-1,-1), HexColor("#e8f4f8")),
        ("LINEABOVE", (0,-1),(-1,-1), 1, NAVY),
    ]
    bt.setStyle(TableStyle(bt_style))
    story.append(bt)
    story.append(Spacer(1, 4*mm))

    # Parcelas
    if parcelas:
        story.append(Paragraph("Cronograma de pagamento:", S["bold"]))
        story.append(Spacer(1, 2*mm))
        parc_data = [["Parcela", "Valor", "Vencimento"]]
        for p in parcelas:
            parc_data.append([p["num"], fmt_brl(p["valor"]), p["vencimento"]])
        pt = Table(parc_data, colWidths=[4*cm, 4*cm, None])
        pt.setStyle(TableStyle([
            ("FONTNAME",  (0,0), (-1,0), "Helvetica-Bold"),
            ("FONTSIZE",  (0,0), (-1,-1), 9),
            ("BACKGROUND",(0,0), (-1,0), NAVY),
            ("TEXTCOLOR", (0,0), (-1,0), white),
            ("ROWBACKGROUNDS",(0,1),(-1,-1),[white, GRAY_LT]),
            ("GRID",      (0,0), (-1,-1), 0.5, GRAY_MID),
            ("TOPPADDING",(0,0), (-1,-1), 5),
            ("BOTTOMPADDING",(0,0),(-1,-1),5),
            ("LEFTPADDING",(0,0),(-1,-1), 8),
            ("ALIGN",     (1,0), (1,-1), "RIGHT"),
        ]))
        story.append(pt)
        story.append(Spacer(1, 3*mm))

    story.append(Paragraph(
        "Os pagamentos deverão ser realizados por meio previamente acordado entre as partes. "
        "Em caso de atraso, incidirão multa de 2% sobre o valor devido e juros de mora de 1% ao mês.",
        S["body"]
    ))

    # ── 4. PRAZO ──────────────────────────────────────────────────────────────
    story.append(Paragraph("4. PRAZO DE ENTREGA", S["h1"]))
    prazo_txt = f"A entrega final está prevista para <b>{delivery or 'data a confirmar'}</b>, condicionada ao envio do acervo, ao cumprimento do cronograma de produção e ao retorno das aprovações dentro dos prazos necessários para continuidade da edição."
    story.append(Paragraph(prazo_txt, S["body"]))
    story.append(Paragraph(
        "Havendo atraso no envio de materiais, mudanças de escopo ou demora em feedbacks, "
        "o prazo de entrega será automaticamente reajustado na mesma proporção.",
        S["body"]
    ))

    # ── 5. RODADAS DE AJUSTE ──────────────────────────────────────────────────
    story.append(Paragraph("5. RODADAS DE AJUSTE", S["h1"]))
    story.append(Paragraph("Estão incluídas <b>3 etapas de ajuste</b>:", S["body"]))
    for item in ["Primeiro corte.", "Ajustes iniciais.", "Ajustes finais."]:
        story.append(Paragraph(f"<bullet>&bull;</bullet> {item}", S["bullet"]))
    story.append(Paragraph(
        "Demandas adicionais além das previstas nesta proposta poderão ser orçadas à parte.",
        S["body"]
    ))

    # ── 6. OBRIGAÇÕES DA CONTRATANTE ──────────────────────────────────────────
    story.append(Paragraph("6. OBRIGAÇÕES DA CONTRATANTE", S["h1"]))
    for item in [
        "Disponibilizar o acervo e materiais necessários para o projeto.",
        "Garantir que possui autorização para uso de imagens, marcas e depoimentos fornecidos.",
        "Centralizar aprovações, preferencialmente por meio de um responsável definido.",
        "Repassar informações, ajustes e validações dentro dos prazos acordados.",
    ]:
        story.append(Paragraph(f"<bullet>&bull;</bullet> {item}", S["bullet"]))

    # ── 7. CAPTAÇÃO E DESLOCAMENTO ────────────────────────────────────────────
    story.append(Paragraph("7. CAPTAÇÃO, LOCAÇÃO E DESLOCAMENTO", S["h1"]))
    loc_txt = f"A presente proposta considera <b>{diarias} diária{'s' if diarias > 1 else ''} de captação</b>"
    if location:
        loc_txt += f" em <b>{location}</b>"
    loc_txt += ". Qualquer necessidade de ampliação de tempo, novas diárias ou deslocamentos adicionais não previstos poderá ser cobrada à parte, mediante aprovação prévia."
    story.append(Paragraph(loc_txt, S["body"]))

    # ── 8. FORMATOS E ENTREGA ─────────────────────────────────────────────────
    story.append(Paragraph("8. FORMATOS, ENTREGA E USO", S["h1"]))
    for item in [
        "Os materiais serão entregues digitalmente, em formato compatível com o uso acordado.",
        "Os arquivos brutos não estão incluídos neste orçamento.",
        "A contratada poderá utilizar trechos e versões do material para portfólio e apresentação comercial, salvo manifestação expressa em contrário por escrito.",
    ]:
        story.append(Paragraph(f"<bullet>&bull;</bullet> {item}", S["bullet"]))

    # ── 9. CANCELAMENTO ───────────────────────────────────────────────────────
    story.append(Paragraph("9. CANCELAMENTO, SUSPENSÃO E REMARCAÇÃO", S["h1"]))
    story.append(Paragraph(
        "Em caso de cancelamento após aceite e início da pré-produção, os valores já pagos poderão ser retidos "
        "proporcionalmente ao estágio executado. Em caso de suspensão por iniciativa da contratante, a contratada "
        "poderá faturar proporcionalmente as etapas já realizadas.",
        S["body"]
    ))

    # ── OBSERVAÇÕES (se houver) ───────────────────────────────────────────────
    if notes:
        story.append(Paragraph("OBSERVAÇÕES", S["h1"]))
        story.append(Paragraph(notes, S["body"]))

    # ── ACEITE + ASSINATURA ───────────────────────────────────────────────────
    story.append(Spacer(1, 6*mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=GRAY_MID))
    story.append(Spacer(1, 4*mm))
    story.append(Paragraph("10. ACEITE", S["h1"]))
    story.append(Paragraph(
        "O aceite desta proposta poderá ocorrer por assinatura física, assinatura digital, "
        "resposta formal por e-mail ou confirmação expressa por WhatsApp, implicando concordância "
        "integral com os termos aqui descritos.",
        S["body"]
    ))
    story.append(Spacer(1, 14*mm))

    # Assinaturas
    sig_data = [[
        [
            HRFlowable(width="100%", thickness=0.5, color=BLACK),
            Spacer(1, 2*mm),
            Paragraph("VIVAI STUDIO / Mateus de Oliveira", S["bold"]),
            Paragraph("Contratada", S["small"]),
        ],
        Spacer(1, 1),
        [
            HRFlowable(width="100%", thickness=0.5, color=BLACK),
            Spacer(1, 2*mm),
            Paragraph(client or "Contratante", S["bold"]),
            Paragraph(f"Contratante{f' — {contact}' if contact else ''}", S["small"]),
            Paragraph(f"CNPJ: {cnpj}" if cnpj else "", S["small"]),
        ],
    ]]
    sig_table = Table(sig_data, colWidths=[None, 1.5*cm, None])
    sig_table.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (-1,-1), 0),
        ("RIGHTPADDING", (0,0), (-1,-1), 0),
    ]))
    story.append(sig_table)

    # Data de geração
    story.append(Spacer(1, 8*mm))
    story.append(Paragraph(
        f"Proposta gerada em {datetime.now().strftime('%d/%m/%Y')} por VIVAI Studio  •  www.studiovivai.com",
        S["footer"]
    ))

    # ── BUILD ─────────────────────────────────────────────────────────────────
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f"PDF gerado: {output_path}")


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python3 generate_pdf.py '<json>' output.pdf [logo.png]")
        sys.exit(1)

    data = json.loads(sys.argv[1])
    output = sys.argv[2]
    logo = sys.argv[3] if len(sys.argv) > 3 else None
    generate(data, output, logo)
