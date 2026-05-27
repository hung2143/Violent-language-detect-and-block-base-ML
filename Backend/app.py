from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import logging
import torch
import torch.nn as nn
from transformers import AutoTokenizer, AutoModel

BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "huggingface")

app = FastAPI()
logger = logging.getLogger("uvicorn.error")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class PhoBERT_MTL(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = AutoModel.from_pretrained(os.path.join(BASE_DIR, "phobert_mtl_model"))
        hidden_size = self.encoder.config.hidden_size
        self.dropout = nn.Dropout(0.3)
        self.classifier_label = nn.Linear(hidden_size, 3)
        self.classifier_target = nn.Linear(hidden_size, 2)

    def forward(self, input_ids, attention_mask):
        outputs = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        pooled_output = outputs.last_hidden_state[:, 0]
        pooled_output = self.dropout(pooled_output)

        logits_label = self.classifier_label(pooled_output)
        logits_target = self.classifier_target(pooled_output)

        return logits_label, logits_target

tokenizer = AutoTokenizer.from_pretrained(os.path.join(BASE_DIR, "phobert_mtl_model"))
model = PhoBERT_MTL()

heads = torch.load(os.path.join(BASE_DIR, "phobert_mtl_model", "heads.pth"), map_location="cpu")
model.classifier_label.load_state_dict(heads["classifier_label"])
model.classifier_target.load_state_dict(heads["classifier_target"])
model.eval()

LABEL_MAP = {
    0: "CLEAN",
    1: "OFFENSIVE",
    2: "HATE"
}

TARGET_MAP = {
    0: "NON_TARGET",
    1: "TARGET"
}

def map_action(label_pred, target_pred):
    if label_pred == 0:
        return "ALLOW"
    # Main label order: 0=CLEAN, 1=OFFENSIVE, 2=HATE
    elif label_pred == 1 and target_pred == 0:
        return "WARN"
    elif label_pred == 1 and target_pred == 1:
        return "BLOCK"
    elif label_pred == 2:
        return "AUTO_BLOCK"
    return "REVIEW"

class TextInput(BaseModel):
    text: str


@app.on_event("startup")
def announce_backend_ready():
    logger.info("Backend ready: API is up and accepting requests.")

@app.get("/")
def root():
    return {"message": "Toxic Guard API is running"}

@app.post("/predict")
def predict(data: TextInput):
    text = data.text.strip()

    inputs = tokenizer(
        text,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=128
    )

    with torch.no_grad():
        logits_label, logits_target = model(
            input_ids=inputs["input_ids"],
            attention_mask=inputs["attention_mask"]
        )

        probs_label = torch.softmax(logits_label, dim=-1)
        probs_target = torch.softmax(logits_target, dim=-1)

        label_pred = torch.argmax(probs_label, dim=-1).item()
        target_pred = torch.argmax(probs_target, dim=-1).item()

        label_conf = probs_label[0][label_pred].item()
        target_conf = probs_target[0][target_pred].item()

    action = map_action(label_pred, target_pred)

    return {
        "label_id": label_pred,
        "label_name": LABEL_MAP[label_pred],
        "label_confidence": round(label_conf, 4),
        "target_id": target_pred,
        "target_name": TARGET_MAP[target_pred],
        "target_confidence": round(target_conf, 4),
        "action": action
    }

# uvicorn app:app --host 127.0.0.1 --port 8000 --reload
# d:\DATN\.venv\Scripts\Activate.ps1
